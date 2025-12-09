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
- **Primary Database**: PostgreSQL (DigitalOcean) - transitioning from MySQL
- **Legacy Database**: MySQL with mysql2 library (being phased out)
- **ORM**: Drizzle ORM for type-safe database operations and migrations
- **Schema Design**: Three main entities (tasks, personnel, assignments) with foreign key relationships
- **Data Validation**: Zod schemas for runtime type checking and API request validation
- **Tri-Write Pattern**: Timeline, containers, selected_cleaners saved to PostgreSQL + filesystem (Python) + MySQL (legacy)
- **Auto-Save**: All assignment changes are automatically persisted with revision tracking

## PostgreSQL Architecture (December 2025) - Flat Tables Design
- **Read Priority**: PostgreSQL ONLY (no fallback to MySQL or filesystem)
- **Write Pattern**: PostgreSQL (primary) + JSON (for Python scripts only) + MySQL (legacy, will be removed)
- **Tables**:
  - `daily_assignments_current`: Current timeline state (1 row per cleaner-task pair)
  - `daily_assignments_history`: All timeline revisions for audit/rollback
  - `daily_assignments_revisions`: Metadata per revision (work_date, revision, task_count, change tracking)
  - `daily_containers`: Current unassigned tasks (flat: 1 row per task)
  - `daily_containers_revisions`: Container revision metadata
  - `daily_containers_history`: All container revisions for undo
  - `daily_selected_cleaners`: Selected cleaners per work_date (INTEGER[] array of cleaner IDs)
  - `cleaners`: Full cleaner data per work_date (replaces cleaners.json)
  - `cleaners_history`: Cleaner snapshots for audit/rollback
- **Container Task Fields**: task_id, logistic_code, client_id, premium, address, lat, lng, cleaning_time, checkin_date, checkout_date, checkin_time, checkout_time, pax_in, pax_out, small_equipment, operation_id, confirmed_operation, straordinaria, type_apt, alias, customer_name, reasons, priority
- **Undo Flow**: When task moves container→timeline, containers history saved first for rollback
- **Service File**: `server/services/pg-daily-assignments-service.ts`

## MySQL Storage Architecture (November 2025) - Two-Table Design
- **Two-Table Architecture**:
  - `daily_assignments_current`: Current state (1 row per work_date, fast queries)
  - `daily_assignments_history`: All revisions for audit/rollback
- **Current Table Schema**: `work_date` (PK), `timeline` (JSON), `selected_cleaners` (JSON), `last_revision` (INT), `updated_at`
- **History Table Schema**: `id` (PK), `work_date`, `revision`, `timeline` (JSON), `selected_cleaners` (JSON), `created_at`, `created_by`
- **Performance**: Reading current state is O(1) - no ORDER BY or LIMIT needed
- **Versioning**: Automatic revision numbering per work_date, stored in both tables
- **Connection**: Pooled connections via mysql2/promise with environment variables (DB_HOST, DB_USER, DB_PASSWORD, DB_NAME, DB_PORT)
- **Files**:
  - `shared/mysql-db.ts`: Connection pool, table initialization, and auto-migration from old schema
  - `server/services/daily-assignment-revisions-service.ts`: CRUD operations with dual-table writes
  - `server/services/workspace-files.ts`: Dual-write logic (filesystem + MySQL)
- **Date Guards**: Writes blocked for past dates to prevent data contamination
- **Deprecated**: Object Storage (`@replit/object-storage`) removed, manual "Conferma Assegnazioni" button removed

## Timeline Data Flow (December 2025) - PostgreSQL Only
- **Source of Truth**: PostgreSQL is the ONLY source of truth for timeline, containers, and selected_cleaners data
- **Frontend Reads**: All frontend components read via API endpoints:
  - `GET /api/timeline?date=YYYY-MM-DD` - Timeline data from PostgreSQL
  - `GET /api/containers?date=YYYY-MM-DD` - Containers data from PostgreSQL
  - `GET /api/selected-cleaners?date=YYYY-MM-DD` - Selected cleaners from PostgreSQL/MySQL
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

## Python API Integration (December 2025)
- **API Client Module**: `client/public/scripts/api_client.py` provides HTTP client for backend API
- **Helper Functions**: `client/public/scripts/api_helpers.py` has shared functions for timeline/containers/cleaners operations
- **Script Support**: All assign scripts (assign_eo.py, assign_hp.py, assign_lp.py) accept `--use-api` flag
- **Current State**: Flag infrastructure ready, but load/save flows still use filesystem. Next phase: modify scripts to use API when flag is active
- **API Endpoints Available**:
  - `GET /api/timeline?date=YYYY-MM-DD` - Load timeline from PostgreSQL
  - `POST /api/timeline` - Save timeline to PostgreSQL (body: {date, timeline})
  - `GET /api/containers?date=YYYY-MM-DD` - Load containers from PostgreSQL
  - `POST /api/containers` - Save containers to PostgreSQL (body: {date, containers})
  - `GET /api/cleaners?date=YYYY-MM-DD` - Load full cleaner data
  - `GET /api/selected-cleaners?date=YYYY-MM-DD` - Load selected cleaner IDs

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