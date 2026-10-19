# Project rules

- Build the frontend with React, TypeScript, Vite, Tailwind CSS, and shadcn/ui conventions. Use npm.
- The product is the **VIC Calibration Interface**. The initially supported workflow is RAT + VIC calibration.
- Keep the four primary routes: Setup, Inputs, Parameters & Calibration, and Run & Results.
- Implement incrementally. Do not build detailed tab interfaces until specifically requested.
- Keep mock data clearly identified. Do not present mock data as scientific results or claim backend behavior.
- Derive scientific inputs, parameters, algorithms, and execution behavior from the existing RAT/VIC implementation; do not invent them.
- Keep server paths, credentials, and sensitive configuration out of frontend code and version control. Do not modify RAT/VIC files for frontend work.
- Avoid adding optional libraries until a specific implemented feature needs them. Keep TypeScript readable and explain non-obvious concepts when useful.
- Reference images in `prototype-1/` are design references. Do not modify, rename, or delete them.
