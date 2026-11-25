"""Start Takecut: `py -3 -m takecut --open` (Windows) or `python3 -m takecut --open`."""
import argparse
import sys
import webbrowser
from pathlib import Path

from . import __version__
from .config import default_data_dir


def main(argv=None):
    parser = argparse.ArgumentParser(prog="takecut", description="Local transcript-driven audio editor.")
    parser.add_argument("--port", type=int, default=8769)
    parser.add_argument("--open", action="store_true", help="open the editor in your browser")
    parser.add_argument("--data-dir", type=Path, default=None, help="where projects are stored")
    args = parser.parse_args(argv)

    from .app import make_server

    data_dir = args.data_dir or default_data_dir()
    try:
        server = make_server(data_dir, args.port)
    except OSError as exc:
        print(f"Port {args.port} is not available ({exc}). Try: --port {args.port + 1}", file=sys.stderr)
        return 1
    url = f"http://127.0.0.1:{server.server_port}/"
    print(f"Takecut {__version__} | {url} | projects: {data_dir}", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
