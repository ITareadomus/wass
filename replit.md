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
- **Schema Design**: Flat tables for `daily_assignments_current`, `daily_assignments_history`, `daily_containers`, `daily_selected_cleaners`, `cleaners`, `aliases`, `app_settings`, and `users`.
- **Data Validation**: Zod schemas for runtime type checking.
- **Revision Tracking**: Comprehensive history tables for assignments, containers, and selected cleaners, including detailed action types for changes.
- **Cleaner Start Time**: Date-scoped `start_time` for cleaners stored in PostgreSQL, with a hierarchy of custom > ADAM > default (10:00).

## Data Flow
- **Source of Truth**: PostgreSQL is the exclusive source for timeline, containers, and selected cleaners.
- **Frontend/Python Interaction**: All data access for both frontend and integrated Python scripts (e.g., `assign_eo.py`, `create_containers.py`) is exclusively via API endpoints, with Python scripts requiring an `--use-api` flag.

## Task Management
- **Priority System**: Three-tier (early-out, high, low) classified from HP Start/End, premium flag, EO/HP client lists, and dedupe strategy.
- **Task Identification**: Unique `task_id` for each task, with `logistic_code` used for deduplication logic during auto-assignment, ensuring only one task per `logistic_code` is automatically assigned.

## Assignment Optimization
- **Fairness**: Global parameters for `NEARBY_TRAVEL_THRESHOLD`, `NEW_CLEANER_PENALTY_MIN`, and `FAIRNESS_DELTA_HOURS` are tightened to ensure more balanced work distribution and safer travel times.
- **Time Window Constraints**: Priority scheduling windows are derived from HP Start/End in `app_settings`: EO before HP Start, HP inside HP Start/End, LP after HP End.

## Optimizer System (Five-Phase)
- **PHASE 0**: Filters locked tasks from processing. Locked tasks in `daily_task_locks` are excluded from optimization.
- **PHASE 1**: Groups nearby tasks using dual thresholds (15min→20min), creates single-task groups for isolated tasks, includes logistic_codes for deduplication.
- **PHASE 2**: Assigns groups to compatible cleaners from daily_selected_cleaners, scores by travel/load/preference, preserves group_logistic_codes.
- **PHASE 3**: Chronological scheduling with time windows and priority soft rules.
  - **Priority Windows** (from app_settings DB): EO ends before HP Start, HP uses HP Start/End, LP starts after HP End.
  - **Soft Rules**: Penalties calculated based on distance from preferred windows (k=2 for EO, k=1 for HP/LP)
  - **Max Penalties**: EO: 120, HP: 90, LP: 60
  - **Permutation Selection**: Considers endTime → priorityPenalty → totalWait → totalTravel
  - **Violation Tracking**: reason codes (LP_BEFORE_MIN_START, EO/HP_OUT_OF_PREFERRED_START_WINDOW) persisted to optimizer_assignment
- **PHASE 4**: Recovery phase for unassigned tasks, attempts to find single-task assignments.
  - **Progressive Penalty System**: Convex penalty formula for unassigned tasks: `base * (1 + multiplier * (k-1))` for k-th task
  - **Parameters**: baseUnassignedPenalty=1500, straordinariaExtraPenalty=2500, progressiveMultiplier=0.5
  - **Example progression**: 1st task: 1500, 2nd: 2250, 3rd: 3000, etc.
  - **Straordinaria penalty**: Uses (base + extra) = 4000 as base, same progressive multiplier
  - **Swap Mechanism**: When insertion fails, tries to swap out a lower-priority task to make room
  - **Swap Logic**: Accepts if netGain > 0 (penalty avoided > loss from removed task)
  - **Re-enqueue**: Task rimosso via swap viene ri-processato (max 2 tentativi) invece di marcarlo subito unassigned

## Phase 2 OT Dropping
- **Dropping Instead of Reject**: Se gruppo OT invalido, droppa task fino a forma valida invece di reject
- **Long OT fix**: Rimuove tutti i task extra, tiene solo l'OT
- **Short OT fix**: Riduce a max 2 task (OT + 1 extra ≤2h)

## OT (Straordinaria) Handling Rules
- **Long OT (≥4h)**: Must be assigned alone, no grouping with other tasks
- **Short OT (<4h)**: Can have max 1 extra task with duration ≤2h
- **OT-first Ordering**: Groups with OT are processed first in Phase 2
- **Scarcity Ordering**: Tasks with fewer compatible cleaners are processed first

## Phase 1 Group Filtering
- **Min Group Size**: Groups must have at least 2 tasks (except OT single groups)
- **OT Single Groups**: Only straordinarie can form valid single-task groups
- **Isolated Normal Tasks**: Deferred to Phase 4 for recovery attempts

## Metrics & Logging
- **Final Metrics**: Total/assigned/unassigned counts, OT breakdown, reasons breakdown
- **Compatible Cleaners**: Each unassigned task shows how many cleaners were compatible
- **OT Warnings**: Detailed log for unassigned straordinarie with reasons and compatible cleaner count
- **Apply to Production**: Optional step to copy results from `optimizer.optimizer_assignment` to `daily_assignments_current`.
- **UI Integration**: "Auto-Assegna" button in timeline header triggers optimizer with visual progress feedback.
- **Fallback**: Old Python script (`assign_eo.py`) preserved at `/api/run-optimizer` endpoint.

# Production Configuration

Configuration is managed via environment variables:
- **Development (Replit)**: Variables loaded from `.env.local` (gitignored)
- **Production (DigitalOcean App Platform)**: Variables set in the deployment panel

# External Dependencies

## Database Services
- **PostgreSQL**: Primary database via DigitalOcean Managed Databases
- **Drizzle Kit**: Database migration and schema management.
- **MySQL**: External read-only source for task data.

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