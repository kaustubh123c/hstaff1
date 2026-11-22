H-STAFF CUSTOMER START -> PAYMENT -> FINISH CODE FLOW

Implemented for scheduled shifts and existing on-demand jobs.

Customer/business flow:
1. Worker accepts/is assigned to the shift.
2. Worker opens My Orders and shares the Start Code when they arrive.
3. Customer enters the Start Code in My Shifts > Manage > Details.
4. Only after successful Start Code verification does the shift become eligible for payment.
5. Customer pays through Razorpay Live Checkout only. Test Mode and offline/demo collection are disabled.
6. Server verifies the Razorpay signature, checks the exact order/amount/currency, captures an authorized payment if needed, and confirms captured status with Razorpay.
7. Worker shares the separate Finish Code.
8. Customer enters the Finish Code. The server checks that payment is paid and the code is valid before setting the shift to Completed.

Security and bypass prevention:
- Business/customer cannot use the direct /shifts/:id/complete endpoint; it returns a conflict and requires the code/payment workflow.
- The customer UI no longer shows a direct Mark completed button. Only Admin retains an emergency override.
- Payment endpoints require an Ongoing shift AND a consumed/verified Start Code.
- Finish verification requires a paid job_payments record.
- Existing encrypted one-time code storage, attempt limits, expiry, worker code display and regenerate-code action are retained.
- Existing Attendance QR and standard timesheet features are retained. The QR can mark a shift Ongoing, but it does not bypass the Start Code: the customer must still verify it before payment is enabled.

Payment configuration:
- Configure RAZORPAY_KEY_ID with an `rzp_live_` key and the matching RAZORPAY_KEY_SECRET in the backend environment. The backend rejects Test Mode keys.
- DEMO_MODE is forced off and the demo-pay API endpoint has been removed. If Live credentials are missing, payment is blocked rather than simulated.
- The worker payout is not automatically transferred by customer checkout; existing payout setup/process still applies. A customer payment is not the same as a worker bank payout.

Validation:
- Node syntax checks passed for the modified backend route files.
- Frontend production build was not run in this environment because dependencies are not installed. Run npm install + npm run build in the frontend project, and install server dependencies before deployment.
