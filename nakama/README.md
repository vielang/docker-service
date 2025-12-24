# Mall App - Nakama Server Module

This directory contains the Nakama server module for Mall App's multiplayer functionality.

## 🎯 Features

- **Global Room Pattern**: Players automatically join a shared global room without needing Match IDs
- **Auto-Match Creation**: Server creates new matches when existing ones are full
- **Player State Management**: Tracks player positions, maps, and presence
- **Scalable**: Supports up to 15 players per match

## 📁 Structure

```
nakama/
├── docker-compose.yml       # Docker setup for local development
├── data/
│   └── local.yml           # Nakama server configuration
└── modules/
    ├── package.json        # Node.js dependencies
    ├── tsconfig.json       # TypeScript configuration
    └── src/
        └── main.ts         # Server module source code
```

## 🚀 Quick Start (Local Development)

### Prerequisites

- Docker & Docker Compose installed
- Node.js 18+ (for building TypeScript)

### Step 1: Build Server Module

```bash
cd nakama/modules
npm install
npm run build
```

This compiles TypeScript to JavaScript in `modules/build/`.

### Step 2: Start Nakama Server

```bash
cd nakama
docker-compose up -d
```

This starts:
- PostgreSQL database (port 5432)
- Nakama server (ports 7349, 7350, 7351)

### Step 3: Verify Server is Running

Open browser: http://localhost:7351

- Username: `admin`
- Password: `password`

You should see the Nakama Console dashboard.

### Step 4: Update Flutter App Configuration

In `lib/shared/services/nakama/nakama_config.dart`:

```dart
static String get host {
  if (kReleaseMode) {
    return 'your-production-server.com';
  }
  // For local development
  return 'localhost'; // or your machine's IP
}
```

**Important**: If testing on physical devices, use your computer's local IP (e.g., `192.168.1.100`) instead of `localhost`.

## 🔧 Development

### Watch Mode (Auto-rebuild)

```bash
cd nakama/modules
npm run watch
```

After making changes to TypeScript code, restart Nakama:

```bash
docker-compose restart nakama
```

### View Logs

```bash
# All logs
docker-compose logs -f

# Nakama only
docker-compose logs -f nakama
```

### Stop Server

```bash
docker-compose down
```

### Clean Everything (including database)

```bash
docker-compose down -v
```

## 📡 RPC Functions

### `get_waiting_match`

Returns a Match ID for the global room. Creates a new match if none are available.

**Request**: Empty or `{}`

**Response**:
```json
{
  "matchId": "abc123...",
  "playerCount": 2,
  "isNew": false
}
```

**Usage in Flutter**:
```dart
final response = await NakamaClient().client.rpc(
  session: session,
  id: 'get_waiting_match',
);
final data = jsonDecode(response);
final matchId = data['matchId'];
```

## 🎮 Match Handler

### Match Lifecycle

1. **Init**: Match created with label `eco_conscience_global`
2. **Join Attempt**: Checks if match has space (< 15 players)
3. **Join**: Adds player to state, broadcasts welcome + join notifications
4. **Loop**: Processes movement messages, updates player positions
5. **Leave**: Removes player, notifies others
6. **Terminate**: Cleanup when match ends

### Match State

```typescript
{
  label: "eco_conscience_global",
  maxPlayers: 15,
  players: {
    "user-id-1": {
      userId: "user-id-1",
      username: "Player1",
      joinedAt: 1234567890,
      currentMap: "outdoors",
      lastPosition: { x: 96, y: 384 }
    }
  },
  createdAt: 1234567890
}
```

### Broadcast Messages

| OpCode | Type | Description |
|--------|------|-------------|
| 1 | `welcome` | Sent to new player with current match state |
| 2 | `player_joined` | Broadcast to others when someone joins |
| 3 | `player_left` | Broadcast when someone leaves |

## 🌐 Production Deployment

### Option 1: Heroic Cloud (Recommended)

1. Create account at https://console.heroiclabs.com/
2. Create new project
3. Upload server module:
   ```bash
   cd nakama/modules
   npm run build
   # Upload build/main.js via Heroic Console
   ```
4. Update Flutter app with production host

### Option 2: Self-Hosted

1. Deploy PostgreSQL database
2. Deploy Nakama server (Docker recommended)
3. Upload compiled server module to `/nakama/data/modules/`
4. Configure firewall (ports 7349, 7350)
5. Use SSL certificates for production

**Production config** (`production.yml`):
```yaml
socket:
  server_key: "YOUR_SECURE_KEY_HERE"  # Change this!
  ssl_certificate: "/path/to/cert.pem"
  ssl_private_key: "/path/to/key.pem"

console:
  username: "admin"
  password: "YOUR_SECURE_PASSWORD"  # Change this!
```

## 🐛 Troubleshooting

### Server won't start

```bash
# Check logs
docker-compose logs nakama

# Common issues:
# - Port already in use: Change ports in docker-compose.yml
# - Module compilation error: Check npm run build output
```

### Can't connect from Flutter app

1. Check server is running: `docker ps`
2. Verify host/port in `nakama_config.dart`
3. For physical devices, use computer's IP, not `localhost`
4. Check firewall allows ports 7349/7350

### RPC not found

1. Verify module is compiled: `ls modules/build/main.js`
2. Check Nakama logs for module load errors
3. Restart Nakama after module changes

## 📚 Resources

- [Nakama Documentation](https://heroiclabs.com/docs/)
- [TypeScript Server Runtime](https://heroiclabs.com/docs/nakama/server-framework/typescript-runtime/)
- [Match Handler Reference](https://heroiclabs.com/docs/nakama/server-framework/typescript-runtime/match-handler/)

## 🤝 Contributing

When modifying server code:

1. Make changes in `modules/src/`
2. Test locally with `npm run build && docker-compose restart nakama`
3. Verify in Nakama Console logs
4. Test with Flutter app
5. Commit both `src/` and compiled `build/` files

## 📝 Notes

- Match IDs are ephemeral - they change when matches end
- Global room pattern means all players join the same match pool
- Max 15 players per match - server creates new matches when full
- Player positions are tracked but not authoritative (client-side for now)
