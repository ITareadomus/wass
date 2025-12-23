# Overview

This is a full-stack task management application designed for scheduling and assigning personnel to tasks with priority-based organization. It features a React frontend with drag-and-drop capabilities, an Express.js backend API, and a PostgreSQL database. The system supports three priority levels (early-out, high, low), provides visual timeline views, statistics panels, and map integration for optimizing task assignments. The project aims to streamline workforce management and enhance operational efficiency.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React with TypeScript (Vite)
- **UI/UX**: shadcn/ui components (Radix UI, Tailwind CSS) for a modular, responsive, and accessible design with custom theming and priority-based color coding.
- **State Management**: TanStack Query for server state and caching.
- **Routing**: Wouter for client-side routing.
- **Core Features**: Drag-and-drop for task assignment, visual timeline, and statistics panels.
- **UX Optimizations**: Normalized date/time pickers and optimized assignment reset logic for improved user experience and responsiveness.

## Backend Architecture
- **Framework**: Express.js with TypeScript, serving RESTful APIs.
- **API Design**: JSON format for requests/responses, centralized error handling, and custom request logging.
- **Build System**: ESBuild for optimized production bundling.
- **Authentication**: Basic session management using `connect-pg-simple` is prepared, but full authentication/authorization is not yet implemented.

## Data Storage
- **Primary Database**: PostgreSQL (DigitalOcean) as the single source of truth.
- **ORM**: Drizzle ORM for type-safe operations and migrations.
- **Schema Design**: Flat tables for `daily_assignments_current`, `daily_assignments_history`, `daily_containers`, `daily_selected_cleaners`, `cleaners`, `cleaner_aliases`, `app_settings`, and `users`.
- **Data Validation**: Zod schemas for runtime type checking.
- **Revision Tracking**: Comprehensive history tables for assignments, containers, and selected cleaners, including detailed action types for changes.
- **Cleaner Start Time**: Date-scoped `start_time` for cleaners stored in PostgreSQL, with a hierarchy of custom > ADAM > default (10:00).

## Data Flow
- **Source of Truth**: PostgreSQL is the exclusive source for timeline, containers, and selected cleaners.
- **Frontend/Python Interaction**: All data access for both frontend and integrated Python scripts (e.g., `assign_eo.py`, `create_containers.py`) is exclusively via API endpoints, with Python scripts requiring an `--use-api` flag.

## Task Management
- **Priority System**: Three-tier (early-out, high, low) with visual indicators.
- **Task Identification**: Unique `task_id` for each task, with `logistic_code` used for deduplication logic during auto-assignment, ensuring only one task per `logistic_code` is automatically assigned.

## Assignment Optimization
- **Fairness**: Global parameters for `NEARBY_TRAVEL_THRESHOLD`, `NEW_CLEANER_PENALTY_MIN`, and `FAIRNESS_DELTA_HOURS` are tightened to ensure more balanced work distribution and safer travel times.
- **Time Window Constraints**: Early-Out (EO) and High Priority (HP) tasks have configurable start/end time windows, loaded dynamically from application settings, restricting when tasks can be assigned. Low Priority (LP) tasks have no time constraints.

## Optimizer System (Three-Phase)
- **PHASE 1**: Groups nearby tasks using dual thresholds (15min→20min), creates single-task groups for isolated tasks, includes logistic_codes for deduplication.
- **PHASE 2**: Assigns groups to compatible cleaners from daily_selected_cleaners, scores by travel/load/preference, preserves group_logistic_codes.
- **PHASE 3**: Chronological scheduling with time windows and priority soft rules.
  - **Priority Windows** (from app_settings DB): EO 10:00-10:59, HP 11:00-15:30, LP 11:00+
  - **Soft Rules**: Penalties calculated based on distance from preferred windows (k=2 for EO, k=1 for HP/LP)
  - **Max Penalties**: EO: 120, HP: 90, LP: 60
  - **Permutation Selection**: Considers endTime → priorityPenalty → totalWait → totalTravel
  - **Violation Tracking**: reason codes (LP_BEFORE_MIN_START, EO/HP_OUT_OF_PREFERRED_START_WINDOW) persisted to optimizer_assignment
- **Shadow Mode**: ALL optimizer writes go to optimizer.* schema only, never touches production tables.

# Production Configuration

## Database Connection Details
- **Database Port**: 25060
- **Node Environment Variables**: 
  - `NODE_ENV=production`
  - `PORT=5000` (frontend & backend on same port)
  - `DATABASE_URL=postgresql://USER:PASSWORD@HOST:25060/DATABASE`
  - `SESSION_SECRET=your-secure-session-secret`

# External Dependencies

## Database Services
- **Neon Database**: Serverless PostgreSQL hosting (port 25060).
- **Drizzle Kit**: Database migration and schema management.
- **ADAM (MySQL)**: External read-only source for task data.

## UI & Styling
- **Radix UI**: Headless UI component primitives.
- **Tailwind CSS**: Utility-first CSS framework.
- **Lucide React**: Icon library.
- **Google Fonts**: Web typography (Architects Daughter, DM Sans, Fira Code, Geist Mono).

## State & Data Management
- **TanStack Query**: Server state management.
- **React Hook Form**: Form state management.
- **Date-fns**: Date manipulation utilities.

## Development Tools
- **TypeScript**: Static type checking.
- **Vite**: Fast build tool.