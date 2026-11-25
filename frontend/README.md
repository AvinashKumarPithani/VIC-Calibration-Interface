# VIC Calibration Interface

A frontend scaffold for a GIS-based interface to calibrate the VIC hydrological model through the existing RAT workflow. The initial workflow is RAT + VIC calibration.

## Requirements

- Node.js (with npm)

## Install dependencies

```bash
npm install
```

## Start the development server

```bash
npm run dev
```

Open the local URL printed by Vite in your browser.

## Build for production

```bash
npm run build
```

## Preview the production build

```bash
npm run preview
```

The Stage I frontend provides project and job management in **Setup**, configuration and input upload/inspection in **Inputs**, and NetCDF parameter inspection and editing in **Parameters & Calibration**. These routes connect to the FastAPI backend for project/job records, uploaded files, inspections, and supported parameter edits. **Run & Results** is a planned route; RAT execution and scientific results are not yet implemented. UI reference images are kept in `prototype-1/`. See the [root README](../README.md) for the full architecture, visual assets, local development setup, and Stage II roadmap.
