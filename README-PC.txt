H-STAFF — LOCAL WINDOWS PC VERSION
==================================

REQUIREMENTS
- Windows 10/11
- Node.js 22.12 or newer (64-bit recommended)
- Internet connection for the first dependency installation
- A modern browser (Chrome or Edge)

FIRST-TIME SETUP
1. Extract the complete ZIP to a normal folder, e.g. C:\HStaff.
2. Install Node.js 22.12+ from https://nodejs.org/ if it is not already installed.
3. Double-click SETUP-PC.bat and wait for both frontend and backend dependencies to install.
4. Double-click START-HSTAFF.bat.
5. Open http://localhost:5173 in Chrome or Edge.
6. Keep the terminal window open while using the application.

OTP ON THIS PC
- Copy server\.env.example to server\.env for local development; local development OTP is enabled by default in that template.
- No SMS is sent in local mode. The development OTP is shown by the app after requesting it.
- OTP expires after 5 minutes by default.
- This mode is for local PC testing only; do not expose this development server publicly.
- To send real SMS instead, set DEV_OTP_ENABLED=false, then configure valid Twilio Account SID,
  Auth Token, and either a From Number or Messaging Service SID in server\.env, then restart.

ADMIN / DEMO DATA
- Use the Admin sign-in screen's Create Admin account option to create your local admin.
- For sample users and jobs, double-click LOAD-DEMO-DATA.bat once.
- Demo accounts (if demo data is loaded):
  Business: abc@hstaff.example / Business@12345
  Worker:   rohit@hstaff.example / Worker@12345
  Other sample business and worker accounts use the same respective passwords.
- Create your own admin account using the Admin registration screen. The admin registration
  option is enabled only for local development.

FEATURES / EXTERNAL SERVICES
- The local application includes the full web UI and local Express API, SQLite database,
  authentication, OTP verification, role-based portals, shifts/jobs, worker operations,
  attendance, geofence checks, KYC document uploads/review, timesheets, disputes,
  notifications, reports, settings, and payment records.
- Database and uploaded files are stored locally under server\data. Keep backups of this folder.
- Razorpay checkout requires valid Razorpay credentials in server\.env. Without them,
  payment records and non-gateway workflows remain available, but live payment processing is off.
- Real SMS requires Twilio credentials. Local OTP mode does not send text messages.
- Google sign-in is optional and requires matching Google OAuth client IDs in root .env
  and server\.env. Email/password and local OTP do not require Google configuration.
- Maps/geolocation uses the browser's location permission and available device location services. GPS APIs store coordinates, accuracy and update time for authenticated active assignments.
- A phone number can be linked to multiple Worker/User accounts; after OTP verification, choose which account to open.

STOPPING
- Press Ctrl+C in the START-HSTAFF.bat terminal window and confirm if prompted.

TROUBLESHOOTING
- If port 5173 or 4000 is already in use, close the other application using that port.
- If dependencies fail to install, check internet access and run SETUP-PC.bat again.
- If Windows blocks scripts, these batch files do not require changing PowerShell execution policy.
- Do not delete server\data; it contains your local database and uploaded documents.
