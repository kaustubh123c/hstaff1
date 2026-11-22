# HStaff Portal Design Update

## What changed
- Added role-specific navigation groups for Customer and Admin accounts.
- Refreshed the Customer workspace with a calmer purple booking-oriented theme.
- Refreshed the Admin workspace with a dark operations sidebar, blue accent theme, clearer navigation hierarchy, and cleaner dashboard/table surfaces.
- Kept the Worker Portal separate and deliberately lightweight, with larger touch targets and minimal controls.
- Preserved the existing API routes, authentication, database schema, booking workflow, and demo checkout behaviour.

## Build and run
1. Extract this project.
2. Run `npm install` in the project root.
3. Run `npm install --prefix server`.
4. Start the backend and frontend using the existing project instructions (`npm run dev:all`).

No live payment credentials are included. The presentation checkout remains a clearly labelled simulation and does not mark any job as paid.
