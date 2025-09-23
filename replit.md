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
- **Database**: PostgreSQL with Neon serverless database integration
- **ORM**: Drizzle ORM for type-safe database operations and migrations
- **Schema Design**: Three main entities (tasks, personnel, assignments) with foreign key relationships
- **Data Validation**: Zod schemas for runtime type checking and API request validation
- **Memory Storage**: In-memory fallback storage implementation with sample data initialization

## Authentication & Authorization
- **Current State**: No authentication system implemented
- **Session Management**: Basic session infrastructure prepared with connect-pg-simple for PostgreSQL session storage

## Priority System Design
- **Task Priorities**: Three-tier system (early-out, high, low) plus unassigned state
- **Visual Indicators**: Color-coded priority system with distinct styling for each level
- **Drag & Drop Workflow**: Tasks can be moved between priority columns and unassigned pool
- **Auto-Assignment**: Backend support for automatic task assignment based on personnel availability and priority

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