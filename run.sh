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

venv/bin/python app.py

