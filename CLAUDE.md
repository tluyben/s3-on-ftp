# Clean TypeScript Project Template

This is a **CLEAN TypeScript project template** designed to be filled by an LLM based on user prompts.

## 🔌 Port Configuration
The port this project should listen on is **NOT hardcoded** — it lives in the file `./.port` at the project root. Always read this file to determine which port to bind to. If `.port` doesn't exist yet (e.g. local dev outside Docker), default to `3000`, but in Docker it will always be present and authoritative.

## 🎯 LLM Instructions

You are working with a **bare-bones TypeScript web project**. Your job is to:

1. **READ the user prompt carefully** to understand what they want to build
2. **Maintain these core files** which are essential for the project to function:
   - `package.json` - Keep dependencies updated as needed
   - `.gitignore` - Add entries for any new build artifacts/secrets
   - `README.md` - Update with project-specific information
   - `PRD.md` - Update with project requirements and goals
3. **Build the application** according to the user's requirements
4. **Keep it web-based** - this project MUST serve web content (API and/or web pages)

## 🚀 Current Setup

### Technology Stack
- **TypeScript** - Strict type checking enabled
- **Express.js** - Web server framework
- **tsx** - Development server with hot reload
- **CORS** - Cross-origin resource sharing enabled

### Available Scripts
- `npm run dev` - Start development server with hot reload (port is read from `./.port`)
- `npm run build` - Compile TypeScript to JavaScript
- `npm run start` - Run compiled JavaScript
- `npm run check` - TypeScript type checking (must pass!)
- `npm run test` - Run tests (implement as needed)

### Docker Integration
- **NORMALLY NOT NEEDED** - claude4ever handles startup automatically
- `start_root` - OPTIONAL: Only if you need custom root-level setup (databases, system packages)
- `start_user` - OPTIONAL: Only if you need custom user-level setup before claude4ever
- **Port is defined in `./.port`** — read this file to know which port to use for Docker compatibility

## 📁 Project Structure

```
src/
├── index.ts          # Main Express server (basic setup provided)
├── routes/           # Add your API routes here
├── controllers/      # Add your business logic here
├── models/           # Add your data models here
├── middleware/       # Add custom middleware here
├── utils/            # Add utility functions here
└── types/            # Add TypeScript type definitions here
```

## ⚠️ CRITICAL Requirements

### 1. Always Maintain Core Files
- **`package.json`** - Update dependencies as you add features
- **`.gitignore`** - Add new entries for build outputs, secrets, etc.
- **`README.md`** - Keep updated with setup instructions
- **`PRD.md`** - Keep updated with current project goals

### 2. TypeScript Compliance
- **`npm run check` MUST pass** - fix all TypeScript errors
- Use **strict typing** - avoid `any` types
- Export types for reusability

### 3. Web Server Requirements
- **MUST serve on the port specified in `./.port`** — read this file at startup to determine the correct port (required for Docker compatibility)
- **MUST bind to 0.0.0.0** (not localhost) for container access
- **Include health check endpoint** at `/health`
- **Support hot reload** during development

### 4. Development Workflow
- Use `npm run dev` for development (hot reload)
- Use `npm run check` before committing
- All code goes in `src/` directory
- Build output goes to `dist/` directory

## 💡 Implementation Guidelines

### When Adding Features:
1. **Install dependencies**: Update package.json with new packages
2. **Create modules**: Organize code into logical modules in src/
3. **Add routes**: Create Express routes for your API endpoints
4. **Type everything**: Create TypeScript interfaces/types
5. **Update docs**: Keep README.md and PRD.md current
6. **Test endpoints**: Ensure `/health` and your endpoints work

### Example Additions:
- **Database**: Add your preferred DB (SQLite, PostgreSQL, etc.)
- **Authentication**: Add JWT, session management, etc.
- **Frontend**: Add React/Vue/Angular build process
- **API docs**: Add Swagger/OpenAPI documentation
- **Testing**: Add Jest, Mocha, or preferred testing framework

## 🔧 Docker Usage

This template works with the claude4ever Docker system:

```bash
# Copy this template to your project directory
cp -r clean-start-ts your-project-name

# Run with Docker (from claude4ever system)
claude4everdocker <port>   # port is also written to ./.port inside the container
```

The Docker container will:
1. **Automatically run `npm install` and `npm run dev`**
2. Execute claude4ever for continuous development
3. **OPTIONALLY** run `start_root` and `start_user` if they exist (usually not needed)

### When to Use Optional Scripts

**Most projects don't need these scripts!** The claude4ever system handles everything automatically.

Only create/modify these scripts if you need:

**`start_root` (runs as root):**
- Install additional system packages (databases, tools)
- Set up system services
- Configure system-level settings

**`start_user` (runs as claude user):**
- Set up additional databases before the app starts
- Run custom initialization scripts
- Configure user-specific settings

**Examples when you might need them:**
- Adding PostgreSQL/MongoDB database
- Installing system tools not in the base image
- Custom environment setup
- Additional services that need to start before your app

## 📋 Template Checklist

Before considering the template complete, ensure:

- [ ] `package.json` has all necessary dependencies
- [ ] `README.md` explains how to run the project
- [ ] `PRD.md` documents what the project does
- [ ] TypeScript compiles without errors (`npm run check`)
- [ ] Server starts and responds at `http://localhost:<PORT>` (where `<PORT>` is the value from `./.port`)
- [ ] Health check works at `http://localhost:<PORT>/health`
- [ ] Hot reload works during development
- [ ] All new files are properly typed with TypeScript

## 🎨 Build Whatever You Want!

This template is intentionally minimal. Based on the user's prompt, you might build:

- **REST API** - Add routes, controllers, data models
- **GraphQL API** - Add Apollo Server or similar
- **Full-stack app** - Add frontend build process
- **Microservice** - Add service-specific logic
- **Real-time app** - Add WebSocket support
- **Data processing** - Add background job processing
- **AI/ML service** - Add AI model integration

**Remember**: Keep it web-based, maintain the core files, and serve on the port specified in `./.port`!