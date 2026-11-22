import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { query, tx } from '../db-postgres.js';
import { config } from '../config.js';
import { authenticate, requireRole } from '../auth-postgres.js';
import {
  wrap, bad, forbidden, notFound, conflict,
  parseId, audit, HttpError
} from '../util-postgres.js';

export const router = Router();
router.use(authenticate);

const MIME = {
  'application/pdf':'.pdf',
  'image/jpeg':'.jpg',
  'image/png':'.png'
};

const upload = multer({
  storage:multer.diskStorage({
    destination:config.uploadDir,
    filename:(_req,file,cb) =>
      cb(null,crypto.randomBytes(16).toString('hex')+(MIME[file.mimetype] ?? ''))
  }),
  limits:{fileSize:5*1024*1024,files:1},
  fileFilter:(_req,file,cb) =>
    MIME[file.mimetype]
      ? cb(null,true)
      : cb(new HttpError(400,'Only PDF, JPG or PNG files are allowed'))
});

const DOC_TYPES = [
  'Identity document',
  'Address proof',
  'Bank / UPI proof',
  'Other'
];

async function syncWorkerStatus(workerId,client=null) {
  const executor = client
    ? (sql,params) => client.query(sql,params)
    : (sql,params) => query(sql,params);

  const result = await executor(
    'SELECT status FROM kyc_documents WHERE worker_id=$1',
    [workerId]
  );

  const docs = result.rows.map(d => d.status);
  const status = !docs.length
    ? 'Not submitted'
    : docs.includes('Rejected')
      ? 'Rejected'
      : docs.every(s => s === 'Verified')
        ? 'Verified'
        : 'Pending';

  await executor(
    'UPDATE workers SET kyc_status=$1 WHERE user_id=$2',
    [status,workerId]
  );

  return status;
}

router.get('/mine',requireRole('worker'),wrap(async(req,res) => {
  const [worker,documents] = await Promise.all([
    query('SELECT kyc_status FROM workers WHERE user_id=$1',[req.user.id]),
    query(
      `SELECT id,doc_type,original_name,mime,size,status,
              review_note,uploaded_at
       FROM kyc_documents WHERE worker_id=$1 ORDER BY id DESC`,
      [req.user.id]
    )
  ]);

  res.json({
    types:DOC_TYPES,
    status:worker.rows[0]?.kyc_status ?? 'Not submitted',
    documents:documents.rows
  });
}));

router.post('/',requireRole('worker'),upload.single('file'),wrap(async(req,res) => {
  const cleanup = () => {
    if (req.file) fs.rm(req.file.path,() => {});
  };

  try {
    if (!req.file) throw bad('Please choose a file to upload');

    const {doc_type} = z.object({
      doc_type:z.enum(DOC_TYPES)
    }).parse(req.body);

    const head = Buffer.alloc(8);
    const fd = fs.openSync(req.file.path,'r');

    try {
      fs.readSync(fd,head,0,8,0);
    } finally {
      fs.closeSync(fd);
    }

    const okSig =
      (req.file.mimetype === 'application/pdf' &&
       head.subarray(0,4).toString() === '%PDF') ||
      (req.file.mimetype === 'image/png' &&
       head.subarray(1,4).toString() === 'PNG') ||
      (req.file.mimetype === 'image/jpeg' &&
       head[0] === 0xff && head[1] === 0xd8);

    if (!okSig) throw bad('File content does not match its type');

    const documentId = await tx(async client => {
      const inserted = await client.query(
        `INSERT INTO kyc_documents
         (worker_id,doc_type,original_name,stored_name,mime,size)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [
          req.user.id,
          doc_type,
          path.basename(req.file.originalname).slice(0,120),
          req.file.filename,
          req.file.mimetype,
          req.file.size
        ]
      );

      await syncWorkerStatus(req.user.id,client);
      return inserted.rows[0].id;
    });

    await audit(req,'kyc.upload','kyc_document',documentId,doc_type);

    const admins = await query(
      "SELECT id FROM users WHERE role='admin'"
    );

    await Promise.all(admins.rows.map(a =>
      query(
        'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
        [a.id,`${req.user.name} submitted a KYC document for review.`]
      )
    ));

    res.status(201).json({ok:true,id:documentId});
  } catch(e) {
    cleanup();
    throw e;
  }
}));

router.get('/:id/file',wrap(async(req,res) => {
  const result = await query(
    'SELECT * FROM kyc_documents WHERE id=$1',
    [parseId(req.params.id)]
  );

  const d = result.rows[0];
  if (!d) throw notFound('Document not found');

  if (!(req.user.role === 'admin' ||
      (req.user.role === 'worker' &&
       Number(d.worker_id) === Number(req.user.id)))) {
    throw forbidden();
  }

  await audit(req,'kyc.view','kyc_document',d.id);

  res.setHeader('X-Content-Type-Options','nosniff');
  res.download(
    path.join(config.uploadDir,d.stored_name),
    d.original_name
  );
}));

router.delete('/:id',requireRole('worker'),wrap(async(req,res) => {
  const result = await query(
    'SELECT * FROM kyc_documents WHERE id=$1 AND worker_id=$2',
    [parseId(req.params.id),req.user.id]
  );

  const d = result.rows[0];
  if (!d) throw notFound('Document not found');
  if (d.status === 'Verified') {
    throw conflict('Verified documents cannot be removed. Contact support.');
  }

  await tx(async client => {
    await client.query(
      'DELETE FROM kyc_documents WHERE id=$1',
      [d.id]
    );
    await syncWorkerStatus(req.user.id,client);
  });

  fs.rm(path.join(config.uploadDir,d.stored_name),() => {});
  await audit(req,'kyc.delete','kyc_document',d.id);

  res.json({ok:true});
}));

router.get('/',requireRole('admin'),wrap(async(_req,res) => {
  const result = await query(
    `SELECT k.id,k.doc_type,k.original_name,k.mime,k.size,
            k.status,k.review_note,k.uploaded_at,k.worker_id,
            u.name AS worker_name
     FROM kyc_documents k
     JOIN users u ON u.id=k.worker_id
     ORDER BY (k.status='Pending') DESC,k.uploaded_at DESC`
  );

  res.json({documents:result.rows});
}));

router.post('/:id/review',requireRole('admin'),wrap(async(req,res) => {
  const d = z.object({
    decision:z.enum(['approve','reject']),
    note:z.string().trim().max(300).optional()
  }).refine(
    v => v.decision === 'approve' || v.note,
    {message:'A reason is required when rejecting',path:['note']}
  ).parse(req.body);

  const result = await query(
    'SELECT * FROM kyc_documents WHERE id=$1',
    [parseId(req.params.id)]
  );

  const doc = result.rows[0];
  if (!doc) throw notFound('Document not found');

  const status = await tx(async client => {
    await client.query(
      `UPDATE kyc_documents
       SET status=$1,review_note=$2,reviewed_by=$3,reviewed_at=NOW()
       WHERE id=$4`,
      [
        d.decision === 'approve' ? 'Verified' : 'Rejected',
        d.note ?? null,
        req.user.id,
        doc.id
      ]
    );

    const workerStatus = await syncWorkerStatus(doc.worker_id,client);

    await client.query(
      'INSERT INTO notifications(user_id,message) VALUES($1,$2)',
      [
        doc.worker_id,
        d.decision === 'approve'
          ? `Your ${doc.doc_type.toLowerCase()} was verified.`
          : `Your ${doc.doc_type.toLowerCase()} was rejected: ${d.note}`
      ]
    );

    return workerStatus;
  });

  await audit(req,`kyc.${d.decision}`,'kyc_document',doc.id,d.note);

  res.json({ok:true,worker_kyc_status:status});
}));
