# Overview

This is a full-stack task management application built for scheduling and assigning personnel to tasks with priority-based organization. The application features a React frontend with drag-and-drop functionality for task management, a Express.js backend API, and PostgreSQL database integration via Drizzle ORM. The system supports three priority levels (early-out, high, low) and provides visual timeline views, statistics panels, and map integration for task assignment optimization.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Frontend Architecture
- **Framework**: React with TypeScript using Vite as the build tool
- **UI Framework**: shadcn/ui components built on Radix UI primitives with Tailwind CSS for styling
- **State Management**: TanStack Query (React Query) for server state management and caching
- **Routing**: Wouter for lightweight client-side routing
- **Drag & Drop**: react-beautiful-dnd for task assignment interface
- **Styling**: Tailwind CSS with custom CSS variables for theming and priority-based color coding

## Backend Architecture
- **Framework**: Express.js with TypeScript
- **API Design**: RESTful APIs with JSON request/response format
- **Error Handling**: Centralized error middleware with structured error responses
- **Request Logging**: Custom middleware for API request logging with response capture
- **Build System**: ESBuild for production bundling with platform-specific optimizations

## Data Storage
- **Primary Database**: PostgreSQL (DigitalOcean) - SINGLE SOURCE OF TRUTH
- **ORM**: Drizzle ORM for type-safe database operations and migrations
- **Schema Design**: Three main entities (tasks, personnel, assignments) with foreign key relationships
- **Data Validation**: Zod schemas for runtime type checking and API request validation
- **Storage Pattern**: PostgreSQL only - filesystem and MySQL removed (December 2025)
- **Auto-Save**: All assignment changes are automatically persisted with revision tracking
- **External Database**: ADAM (MySQL) - external source database for task data only (read-only sync)

## PostgreSQL Architecture (December 2025) - Flat Tables Design
- **Read/Write**: PostgreSQL ONLY (MySQL revisions service removed)
- **Tables**:
  - `daily_assignments_current`: Current timeline state (1 row per cleaner-task pair)
  - `daily_assignments_history`: All timeline revisions for audit/rollback
  - `daily_assignments_revisions`: Metadata per revision (work_date, revision, task_count, change tracking)
  - `daily_containers`: Current unassigned tasks (flat: 1 row per task)
  - `daily_containers_revisions`: Container revision metadata
  - `daily_containers_history`: All container revisions for undo
  - `daily_selected_cleaners`: Selected cleaners per work_date (INTEGER[] array of cleaner IDs)
  - `selected_cleaners_revisions`: Revision history for selected_cleaners changes with descriptive action types (see below)
  - `cleaners`: Full cleaner data per work_date, INCLUDING start_time which is date-scoped (replaces cleaners.json)
  - `cleaner_aliases`: Permanent aliases for cleaners (date-independent, replaces alias column)
  - `app_settings`: Key-value store for application settings (replaces settings.json, client_timewindows.json)
  - `users`: User accounts with hashed passwords (replaces accounts.json)
- **Removed Tables (December 2025)**:
  - `cleaners_history`: Removed - no longer needed for audit
- **Container Task Fields**: task_id, logistic_code, client_id, premium, address, lat, lng, cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time, pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria, type_apt, alias, customer_name, reasons, priority
- **Undo Flow**: When task moves container→timeline, containers history saved first for rollback
- **Selected Cleaners Revisions**: Every change to daily_selected_cleaners is tracked with before/after state, descriptive action type, and performer
  - Action types: `'add'` (cleaner aggiunto), `'removal'` (cleaner rimosso), `'replace'` (lista completamente sostituita), `'swap'` (cleaners scambiati), `'rollback'` (ripristino a revisione precedente), `'init'` (inizializzazione)
  - Each revision includes: cleaners_before[], cleaners_after[], action_type, action_payload (metadata specifici dell'azione), performed_by, created_at
- **Cleaner Aliases**: Permanent table for cleaner display names, independent of work_date (37 aliases imported Dec 11, 2025)
- **Start Time Management (December 11, 2025 - Date-Scoped with Hierarchy)**: 
  - **Gerarchia**: PostgreSQL custom (date-scoped) > tw_start ADAM > 10:00 default
  - Each cleaner's start_time is stored per work_date in the `cleaners` table (date-scoped)
  - When user modifies start_time via `/api/update-cleaner-start-time`, it saves ONLY for that date
  - `extract_cleaners_optimized.py` applies gerarchia: reads custom from PostgreSQL, falls back to tw_start ADAM, defaults to 10:00
  - Backend default in `saveCleanersForDate()` applies 10:00 only when start_time is null
  - This prevents modified start_times from affecting other dates
- **Service File**: `server/services/pg-daily-assignments-service.ts`

## Timeline Data Flow (December 2025) - PostgreSQL Only
- **Source of Truth**: PostgreSQL is the ONLY source of truth for timeline, containers, and selected_cleaners data
- **Frontend Reads**: All frontend components read via API endpoints:
  - `GET /api/timeline?date=YYYY-MM-DD` - Timeline data from PostgreSQL
  - `GET /api/containers?date=YYYY-MM-DD` - Containers data from PostgreSQL
  - `GET /api/selected-cleaners?date=YYYY-MM-DD` - Selected cleaners from PostgreSQL
  - `generate-assignments.tsx`: loadTasks() uses /api/containers and /api/timeline
  - `timeline-view.tsx`: loadTimelineData(), loadTimelineCleaners(), loadCleaners() use API endpoints
  - `convocazioni.tsx`: Uses /api/selected-cleaners and /api/timeline for cleaner preselection
  - `map-section.tsx`: Uses /api/selected-cleaners for cleaner colors
- **JSON Files Deprecated**: `timeline.json`, `containers.json`, and `selected_cleaners.json` are no longer read by frontend
- **Python Script Compatibility**: JSON files still written for legacy Python scripts (to be migrated)

## Authentication & Authorization
- **Current State**: No authentication system implemented
- **Session Management**: Basic session infrastructure prepared with connect-pg-simple for PostgreSQL session storage

## Priority System Design
- **Task Priorities**: Three-tier system (early-out, high, low) plus unassigned state
- **Visual Indicators**: Color-coded priority system with distinct styling for each level
- **Drag & Drop Workflow**: Tasks can be moved between priority columns and unassigned pool
- **Auto-Assignment**: Backend support for automatic task assignment based on personnel availability and priority

## Task Identification and Deduplication (November 2025)
- **Unique Identifier**: Each task is uniquely identified by `task_id` (primary key)
- **Logistic Code**: The `logistic_code` field can have duplicates across different tasks
- **Deduplication Logic**: 
  - Python assignment scripts (assign_eo.py, assign_hp.py, assign_lp.py) track assigned `logistic_code` values from timeline.json
  - Only ONE task per `logistic_code` is assigned automatically during the assignment flow
  - Duplicate tasks (same logistic_code, different task_id) remain in containers for manual drag-and-drop assignment
  - Container cleanup uses `task_id` (not logistic_code) to ensure unassigned duplicates are preserved
- **Assignment Flow**: create_containers.py → assign_eo.py → assign_hp.py → assign_lp.py → timeline.json
- **Verification**: Tested with logistic_code 777 (task_ids 210458, 218427) - one assigned, one kept in container

## Python API Integration (December 2025) - API-Only Mode
- **API Client Module**: `client/public/scripts/api_client.py` provides HTTP client for backend API (uses urllib, no external dependencies)
- **Helper Functions**: `client/public/scripts/api_helpers.py` has shared functions for timeline/containers/cleaners operations
- **Script Support**: ALL Python scripts require `--use-api` flag and fail if API unavailable (no filesystem fallback)
- **Scripts Migrated to API-Only**:
  - `assign_eo.py`: Reads timeline/containers from API, writes timeline to API
  - `assign_hp.py`: Reads timeline/containers from API, writes timeline to API
  - `assign_lp.py`: Reads timeline/containers from API, writes timeline to API
  - `create_containers.py`: Reads timeline from API, writes containers to API
- **Static Config Exceptions**: `settings.json` and `operations.json` still use filesystem (configuration, not runtime data)
- **Backend Invocation**: All Python script calls include `--use-api` flag
- **Health Check**: `/api/health` endpoint for Python client connection testing
- **Current State**: API is default mode; filesystem only used as offline fallback
- **API Endpoints Available**:
  - `GET /api/timeline?date=YYYY-MM-DD` - Load timeline from PostgreSQL
  - `POST /api/timeline` - Save timeline to PostgreSQL (body: {date, timeline})
  - `GET /api/containers?date=YYYY-MM-DD` - Load containers from PostgreSQL
  - `POST /api/containers` - Save containers to PostgreSQL (body: {date, containers})
  - `GET /api/cleaners?date=YYYY-MM-DD` - Load full cleaner data
  - `GET /api/selected-cleaners?date=YYYY-MM-DD` - Load selected cleaner IDs

## Assignment Fairness Optimization (December 11, 2025)
- **Global Parameters** (assign_utils.py):
  - `NEARBY_TRAVEL_THRESHOLD`: 5 min (down from 7) - stricter definition of "same block"
  - `NEW_CLEANER_PENALTY_MIN`: 45 min (down from 60) - lower cost to activate new cleaner
  - `FAIRNESS_DELTA_HOURS`: 0.5h (down from 1.0h) - tighter tolerance for hour balance
- **Early-Out Priority** (assign_eo.py):
  - `CLUSTER_EXTENDED_TRAVEL`: 7.0 min (down from 10.0) - reduced extended clusters
- **High Priority** (assign_hp.py):
  - `CLUSTER_EXTENDED_TRAVEL`: 7.0 min (down from 10.0)
  - `CLUSTER_MAX_TRAVEL`: 12.0 min (down from 15.0)
  - `ZONE_RADIUS_KM`: 0.20 km (down from 0.25) - smaller micro-zones
  - `PREFERRED_TRAVEL`: 18.0 min (down from 20.0)
  - `NEARBY_TRAVEL_THRESHOLD`: 5 min (down from 7)
- **Low Priority** (assign_lp.py):
  - `CLUSTER_EXTENDED_TRAVEL`: 7.0 min (down from 10.0)
  - `CLUSTER_MAX_TRAVEL`: 12.0 min (down from 15.0)
  - `ZONE_RADIUS_KM`: 0.6 km (down from 0.8)
  - `PREFERRED_TRAVEL`: 18.0 min (down from 20.0)
  - `NEARBY_TRAVEL_THRESHOLD`: 5 min (down from 7)
- **Effect**: More balanced work distribution, fewer "clusteroni", safer travel time constraints

## Frontend UX Optimization (December 11, 2025)
- **handleResetAssignments()** (timeline-view.tsx):
  - Removed redundant fetch calls to `/api/containers` and `/api/timeline`
  - Now uses single reload pipeline: `reloadAllTasks()` → `loadTimelineData()`
  - Added immediate UI feedback: timeline clears before async operations complete
  - State: `isResetting` tracks operation status for button/dialog disabling
  - Spinner shows in button during reset for user feedback

## Component Architecture
- **Modular Design**: Separate components for drag-drop interface, timeline view, statistics panel, and map section
- **Reusable UI**: Comprehensive component library with consistent styling and accessibility features
- **Responsive Design**: Mobile-first approach with adaptive layouts and touch-friendly interactions

# External Dependencies

## Database Services
- **Neon Database**: Serverless PostgreSQL hosting with connection pooling
- **Drizzle Kit**: Database migration and schema management tools

## UI & Styling
- **Radix UI**: Headless component primitives for accessibility and behavior
- **Tailwind CSS**: Utility-first CSS framework with custom design system
- **Lucide React**: Icon library with consistent visual design
- **Google Fonts**: Web typography (Architects Daughter, DM Sans, Fira Code, Geist Mono)

## State & Data Management
- **TanStack Query**: Server state synchronization and caching
- **React Hook Form**: Form state management with validation
- **Date-fns**: Date manipulation and formatting utilities

## Development Tools
- **Replit Integration**: Development environment plugins for runtime error handling and debugging
- **TypeScript**: Static type checking and enhanced development experience
- **Vite**: Fast build tool with hot module replacement and optimized bundling