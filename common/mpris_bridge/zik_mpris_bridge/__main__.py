import signal
import sys
import threading


def main() -> None:
    stop = threading.Event()

    def _shutdown(_signum, _frame) -> None:
        stop.set()

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    sys.stdout.write("zik-mpris-bridge: idle stub; waiting for SIGTERM/SIGINT\n")
    sys.stdout.flush()
    stop.wait()


if __name__ == "__main__":
    main()
