#!/bin/bash
# Quick run script - uses venv's python directly

if [ ! -d "venv" ]; then
    echo "Virtual environment not found. Please run ./build.sh first."
    exit 1
fi

if [ ! -f "venv/bin/python" ]; then
    echo "Virtual environment appears to be corrupted. Please run ./build.sh to recreate it."
    exit 1
fi

# Try to find local IP address (macOS specific check first, then fallback)
LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ifconfig | grep "inet " | grep -v 127.0.0.1 | head -n 1 | awk '{print $2}')

echo "----------------------------------------------------"
echo "BTT Manip Backend"
echo "Local access:   http://localhost:5001/"
if [ ! -z "$LOCAL_IP" ]; then
    echo "Network access: http://$LOCAL_IP:5001/"
fi
echo "----------------------------------------------------"

venv/bin/python app.py

