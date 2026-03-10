# Clean TypeScript Project

> **🔄 UPDATE THIS README** - This is a template. Replace this content with your actual project description.

## 📋 Project Description

[REPLACE ME] - Describe what your project does, who it's for, and why it exists.

## 🚀 Quick Start

### Prerequisites
- Node.js 18+
- npm or yarn

### Installation

```bash
# Clone/copy this project
git clone [your-repo] # or copy the template

# Install dependencies
npm install

# Start development server
npm run dev
```

The server will start at the port specified in `./.port` (defaults to `3000` if the file doesn't exist).

### Available Endpoints

- `GET /` - Welcome message and server info
- `GET /health` - Health check endpoint
- `GET /api/hello?name=YourName` - Example API endpoint

[REPLACE ME] - Add your actual API endpoints here

## 🛠️ Development

### Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run check` - TypeScript type checking
- `npm run test` - Run tests

### Project Structure

```
src/
├── index.ts          # Main server entry point
├── routes/           # API route handlers
├── controllers/      # Business logic
├── models/           # Data models
├── middleware/       # Custom middleware
├── utils/            # Utility functions
└── types/            # TypeScript definitions
```

### Adding Features

1. **New Route**: Add to `src/routes/`
2. **Business Logic**: Add to `src/controllers/`
3. **Data Models**: Add to `src/models/`
4. **Types**: Add to `src/types/`

Always run `npm run check` to ensure TypeScript compliance.

## 🐳 Docker Usage

This project works with the claude4ever Docker system:

```bash
# Copy template to your project
cp -r clean-start-ts your-project-name
cd your-project-name

# Run with Docker (automatically handles npm install and npm run dev)
claude4everdocker <port>   # port is also written to ./.port inside the container
```

The Docker system automatically:
- Installs dependencies (`npm install`)
- Starts development server (`npm run dev`)
- Manages the application lifecycle

**Note**: The included `start_root` and `start_user` scripts are optional examples. Most projects don't need them - delete them if you don't need custom setup.

## 🧪 Testing

[REPLACE ME] - Add information about your testing setup

```bash
npm run test
```

## 🚀 Deployment

[REPLACE ME] - Add deployment instructions

### Environment Variables

[REPLACE ME] - Document any environment variables needed

```bash
PORT=<from ./.port>          # Server port — read from ./.port file (defaults to 3000 if absent)
NODE_ENV=production          # Environment mode
# Add your variables here
```

## 📚 API Documentation

[REPLACE ME] - Link to API documentation or add inline docs

### Example Endpoints

#### GET /health
Health check endpoint

**Response:**
```json
{
  "status": "healthy",
  "uptime": 123.45,
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### GET /api/hello?name=World
Example greeting endpoint

**Response:**
```json
{
  "message": "Hello, World!",
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

[REPLACE ME] - Add your actual API documentation

## 🤝 Contributing

[REPLACE ME] - Add contribution guidelines if this is a team project

## 📄 License

[REPLACE ME] - Add your license

## 🔗 Links

- [Repository](#) - Add your repository link
- [Documentation](#) - Add documentation link
- [Issues](#) - Add issues link

---

**Note**: This README was generated from a template. Please update it with your actual project information.