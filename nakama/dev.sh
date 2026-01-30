#!/bin/bash
# Nakama Development Script
# Usage:
#   ./dev.sh build    - Build TypeScript and restart Nakama
#   ./dev.sh watch    - Watch mode (auto-restart on changes)
#   ./dev.sh logs     - View Nakama logs
#   ./dev.sh restart  - Restart Nakama only

set -e
cd "$(dirname "$0")"

case "$1" in
  build)
    echo "📦 Building TypeScript..."
    cd modules && npm run build && cd ..
    echo "🔄 Restarting Nakama..."
    docker restart nakama
    sleep 3
    echo "✅ Done! Checking logs..."
    docker logs nakama --tail 10
    ;;

  watch)
    echo "👀 Starting watch mode..."
    echo "   Nakama will auto-restart when main.js changes"
    docker compose watch
    ;;

  logs)
    docker logs -f nakama
    ;;

  restart)
    echo "🔄 Restarting Nakama..."
    docker restart nakama
    sleep 3
    docker logs nakama --tail 10
    ;;

  *)
    echo "Usage: ./dev.sh {build|watch|logs|restart}"
    echo ""
    echo "Commands:"
    echo "  build   - Build TypeScript and restart Nakama"
    echo "  watch   - Watch mode (auto-restart on changes)"
    echo "  logs    - View Nakama logs"
    echo "  restart - Restart Nakama only"
    exit 1
    ;;
esac
