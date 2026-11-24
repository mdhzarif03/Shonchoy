"""Launcher. Run with:  python run_shonchoy.py [optional files or archives]"""
import sys

from shonchoy.app import main

if __name__ == "__main__":
    main(sys.argv[1:])
