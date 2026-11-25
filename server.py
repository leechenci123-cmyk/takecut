"""Kept so `py -3 server.py --open` from older instructions still works. Same as `py -3 -m takecut`."""
import sys

from takecut.__main__ import main

if __name__ == "__main__":
    sys.exit(main())
