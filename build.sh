#!/bin/bash
# Build script for WSL/Linux with virtual environment support

# Check if venv exists, create if not
if [ ! -d "venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv venv
    
    if [ $? -ne 0 ]; then
        echo "Error: Failed to create virtual environment."
        echo "You may need to install python3-venv:"
        echo "  sudo apt update && sudo apt install python3-venv python3-full"
        exit 1
    fi
fi

# Use venv's pip and python directly to avoid activation issues
VENV_PIP="venv/bin/pip"
VENV_PYTHON="venv/bin/python"

# Check if venv pip exists
if [ ! -f "$VENV_PIP" ]; then
    echo "Error: Virtual environment appears to be corrupted."
    echo "Removing and recreating..."
    rm -rf venv
    python3 -m venv venv
    if [ $? -ne 0 ]; then
        echo "Error: Failed to recreate virtual environment."
        exit 1
    fi
fi

echo "Upgrading pip in virtual environment..."
$VENV_PIP install --upgrade pip

echo ""
echo "Installing Python dependencies..."
$VENV_PIP install -r requirements.txt

if [ $? -ne 0 ]; then
    echo ""
    echo "Error: Failed to install dependencies."
    exit 1
fi

echo ""
echo "Building C++ extension module..."
# Use venv's python to get the correct pybind11 includes and extension suffix
c++ -O3 -Wall -shared -std=c++11 -fPIC $($VENV_PYTHON -m pybind11 --includes) rng.cpp -o rng$($VENV_PYTHON -c "import sysconfig; print(sysconfig.get_config_var('EXT_SUFFIX'))")

if [ $? -eq 0 ]; then
    echo ""
    echo "Build successful! You can now run the app with:"
    echo "  source venv/bin/activate"
    echo "  python3 app.py"
    echo ""
    echo "Or use the run script:"
    echo "  ./run.sh"
else
    echo ""
    echo "Build failed. Please check the error messages above."
    exit 1
fi

