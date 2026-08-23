# 🚀 Vd-Pro Video Extraction Platform - Epic Edition v2.0

Enterprise-grade video extraction platform built with Node.js, Playwright, and modern streaming technologies.

## ✨ Features

### Core Features
- 🎯 **Video Extraction**: Extract video URLs from websites
- 🔍 **Content Search**: Search for movies/series by name
- 🎬 **Multi-Format Support**: m3u8, mp4, webm
- 🎚️ **Quality Filtering**: Select specific quality (720p, 1080p, etc)

### Advanced Features
- 🔐 **Advanced Proxy Management**: Health checks + rotation
- 🍪 **Session Persistence**: Cookie management + auto-replay
- 🎭 **Dynamic Stealth**: Anti-detection fingerprinting
- 🖱️ **Human Interaction**: Natural mouse movement (Bezier curves)
- ⚡ **Context Pooling**: Efficient browser resource management
- 📊 **Multi-Strategy Extraction**: 5+ extraction methods
- 💾 **3-Level Cache**: L1 (Memory) + L2 (Redis) + L3 (MongoDB)
- 🔄 **Circuit Breaker**: Smart failure handling
- 📈 **Prometheus Metrics**: Complete monitoring
- 🔒 **SSRF Protection**: Security validation
- 🪝 **Webhooks**: Real-time notifications
- 📱 **WebSocket**: Live job status updates

## 🛠️ Installation

### Prerequisites
- Node.js >= 18.0.0
- MongoDB Atlas account (or local MongoDB)
- Redis Cloud account (or local Redis)
- npm or yarn

### Setup Steps

```bash
# 1. Clone repository
git clone <repo-url>
cd vd-pro

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 4. Run development server
npm run dev

# 5. Or production
npm run prod
```

## 📝 Environment Variables

```bash
# Server
NODE_ENV=production
PORT=3000

# Security
JWT_SECRET=your-secret-key-here

# Database
MONGODB_URL=mongodb+srv://user:pass@host/database?retryWrites=true&w=majority

# Cache
REDIS_URL=redis://user:pass@host:port

# Proxies (optional)
PROXIES=http://proxy1:8080,http://proxy2:8080

# Logging
LOG_LEVEL=info
```

## 📊 API Endpoints

### Health & Status
```bash
GET /api/v1/health              # Health check
GET /api/v1/metrics             # Prometheus metrics
GET /api/v1/proxy-status        # Proxy status
```

### Authentication
```bash
POST /api/v1/auth/register      # Register user
```

Body:
```json
{
  "email": "user@example.com",
  "password": "password123",
  "plan": "free"
}
```

Response:
```json
{
  "success": true,
  "apiKey": "...",
  "token": "...",
  "plan": "free"
}
```

### Video Extraction
```bash
GET /api/v1/extract?url=<URL>&quality=<quality>
```

Response:
```json
{
  "success": true,
  "jobId": "123",
  "statusUrl": "/api/v1/jobs/123"
}
```

### Search
```bash
GET /api/v1/search?q=<query>&quality=<quality>
```

### Job Management
```bash
GET /api/v1/jobs/:jobId         # Get job status
POST /api/v1/jobs/:jobId/retry  # Retry failed job
```

### Webhooks
```bash
POST /api/v1/webhooks           # Create webhook
```

Body:
```json
{
  "url": "https://your-endpoint.com/webhook",
  "events": ["extraction.complete", "extraction.failed"]
}
```

## 💻 Usage Examples

### Register User
```bash
curl -X POST http://localhost:3000/api/v1/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "user@example.com",
    "password": "password123",
    "plan": "free"
  }'
```

### Extract Video
```bash
curl "http://localhost:3000/api/v1/extract?url=https://example.com/video&quality=1080p" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Search Content
```bash
curl "http://localhost:3000/api/v1/search?q=Breaking%20Bad&quality=720p" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Check Job Status
```bash
curl "http://localhost:3000/api/v1/jobs/JOB_ID" \
  -H "Authorization: Bearer YOUR_TOKEN"
```

### Setup Webhook
```bash
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -d '{
    "url": "https://your-endpoint.com/webhook",
    "events": ["extraction.complete"]
  }'
```

## 🐳 Docker Deployment

### Build & Run
```bash
docker-compose up -d
```

### View Logs
```bash
docker-compose logs -f app
```

### Stop
```bash
docker-compose down
```

## 📊 API Documentation

Visit `http://localhost:3000/api-docs` for interactive Swagger documentation.

## ⚙️ Configuration

### Proxy Management
- Automatic health checks every 5 minutes
- Rotation on each request
- Auto-mark unavailable after 3 consecutive failures
- Recovery attempted with exponential backoff

### Caching Strategy
- **L1**: In-memory (100 items max)
- **L2**: Redis (86400 seconds)
- **L3**: MongoDB (259200 seconds)

### Extraction Strategies
1. **Network**: Route-based interception
2. **DOM**: DOM parsing with cheerio
3. **Script**: Regex-based URL extraction
4. **MSE**: MediaSource interception
5. **XHR**: Fetch/XMLHttpRequest interception

### Circuit Breaker
- **Threshold**: 5 failures
- **Timeout**: 60 seconds
- **Recovery**: 2 successful requests

## 🔒 Security

- ✅ JWT authentication
- ✅ Rate limiting (100 requests/15 min per user)
- ✅ SSRF protection with DNS validation
- ✅ MongoDB injection prevention
- ✅ Helmet security headers
- ✅ Cookie validation & sanitization
- ✅ Proxy validation before use

## 📈 Monitoring

### Metrics Available
- HTTP request duration
- Extraction duration
- Success/failure rates
- Cache hit rates (L1/L2/L3)
- Proxy health status

Visit `/api/v1/metrics` for Prometheus format metrics.

## 🐛 Error Handling

All errors follow this format:
```json
{
  "success": false,
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

Error codes:
- `MISSING_FIELDS`: Required fields missing
- `MISSING_URL`: URL parameter required
- `INVALID_URL`: URL validation failed
- `DB_UNAVAILABLE`: Database connection failed
- `JOB_NOT_FOUND`: Job ID doesn't exist
- `NO_FAILED_JOB`: No failed job to retry
- `EXTRACT_ERROR`: Extraction failed
- `SEARCH_ERROR`: Search failed

## 🚀 Performance Tips

1. **Use proxies** for better reliability
2. **Enable caching** to reduce extraction time
3. **Set appropriate quality** to filter results
4. **Use webhooks** instead of polling
5. **Monitor metrics** for insights

## 📄 License

MIT License - See LICENSE file

## 🤝 Contributing

Pull requests are welcome. For major changes, open an issue first.

## 📧 Support

For issues and questions, create a GitHub issue or contact the team.

---

**Made with ❤️ by Vd-Pro Team**

Last Updated: 2026-08-23
 
