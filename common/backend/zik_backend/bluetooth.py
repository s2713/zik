"""Bluetooth integration — BlueZ D-Bus agent + user-facing REST API.

In production (Target 2+) this module registers an org.bluez.Agent1 service on
the system D-Bus so every pairing confirmation is routed through the browser UI
instead of being auto-accepted (Just-Works).

In demo mode (python3-dbus or org.bluez absent) all endpoints return HTTP 503
and the module is otherwise a no-op.

Concurrency model
-----------------
BlueZ requires a GLib main loop to dispatch D-Bus method calls.  We run that
loop in a dedicated daemon thread ("bluez-glib").  The HTTP route handlers live
in uvicorn's asyncio loop.  The two sides share two primitives:

  _req       – dict | None   : current pending pairing request (None = idle)
  _req_event – threading.Event: HTTP handler sets this once accept/reject is known
  _req_lock  – threading.Lock : guards _req and _req_accepted

The GLib thread blocks in RequestConfirmation() on _req_event.wait(timeout);
the asyncio handler sets _req_accepted then _req_event.set().
"""

import contextlib
import logging
import threading

from starlette.requests import Request
from starlette.responses import JSONResponse
from starlette.routing import Route

log = logging.getLogger(__name__)

_AGENT_PATH    = "/org/zik/agent"
_CAPABILITY    = "DisplayYesNo"   # enable numeric-compare; disables Just-Works auto-accept
_PAIR_TIMEOUT  = 30               # seconds before auto-reject a forgotten pairing dialog
_SCAN_TIMEOUT  = 30               # seconds before discovery auto-stops


# ---------------------------------------------------------------------------
# D-Bus agent (instantiated only when python3-dbus + BlueZ are available)
# ---------------------------------------------------------------------------

def _make_agent_class(dbus_mod):
    """Return the Agent1 class using the given dbus module (avoids import-time errors)."""
    import dbus.service as _svc  # noqa: PLC0415

    class _Agent(_svc.Object):
        """BlueZ Agent1 implementation — routes pairing to the browser UI."""

        def __init__(self, conn, path, mgr: "BlueZManager"):
            super().__init__(conn, path)
            self._mgr = mgr

        @_svc.method("org.bluez.Agent1", in_signature="ou", out_signature="")
        def RequestConfirmation(self, device, passkey: int) -> None:
            """Ask the browser to confirm a numeric passkey; block until answered."""
            dev_info = self._mgr._device_info_by_path(str(device))
            name    = dev_info.get("name", str(device))
            address = dev_info.get("address", "?")
            log.info("bluetooth: pairing request from %s (%s) passkey=%06d", name, address, passkey)

            with self._mgr._req_lock:
                self._mgr._req = {
                    "device":  str(device),
                    "name":    name,
                    "address": address,
                    "passkey": f"{passkey:06d}",
                }
                self._mgr._req_event.clear()
                self._mgr._req_accepted = False

            accepted = self._mgr._req_event.wait(timeout=_PAIR_TIMEOUT)

            with self._mgr._req_lock:
                result   = accepted and self._mgr._req_accepted
                self._mgr._req = None

            if not result:
                log.info("bluetooth: pairing rejected/timed-out for %s", address)
                raise dbus_mod.exceptions.DBusException(  # type: ignore[union-attr]
                    name="org.bluez.Error.Rejected",
                    message="User rejected the pairing request",
                )
            log.info("bluetooth: pairing accepted for %s", address)

        @_svc.method("org.bluez.Agent1", in_signature="o", out_signature="s")
        def RequestPinCode(self, device) -> str:  # noqa: ARG002
            """PIN-code pairing not supported — reject."""
            raise dbus_mod.exceptions.DBusException(  # type: ignore[union-attr]
                name="org.bluez.Error.Rejected",
                message="PIN code pairing not supported",
            )

        @_svc.method("org.bluez.Agent1", in_signature="ou", out_signature="")
        def DisplayPasskey(self, device, passkey: int) -> None:  # noqa: ARG002
            pass  # informational only — frontend sees it via pairing-request poll

        @_svc.method("org.bluez.Agent1", in_signature="os", out_signature="")
        def DisplayPinCode(self, device, pincode: str) -> None:  # noqa: ARG002
            pass

        @_svc.method("org.bluez.Agent1", in_signature="o", out_signature="")
        def RequestAuthorization(self, device) -> None:  # noqa: ARG002
            pass  # trust already-paired devices

        @_svc.method("org.bluez.Agent1", in_signature="os", out_signature="")
        def AuthorizeService(self, device, uuid: str) -> None:  # noqa: ARG002
            pass  # allow any service on paired devices

        @_svc.method("org.bluez.Agent1", in_signature="", out_signature="")
        def Cancel(self) -> None:
            with self._mgr._req_lock:
                self._mgr._req = None
                self._mgr._req_event.set()

        @_svc.method("org.bluez.Agent1", in_signature="", out_signature="")
        def Release(self) -> None:
            pass

    return _Agent


# ---------------------------------------------------------------------------
# Manager
# ---------------------------------------------------------------------------

class BlueZManager:
    """Manages the BlueZ GLib thread, agent registration, and device operations."""

    def __init__(self) -> None:
        self.available   = False   # True once BlueZ + agent are up
        self._bus        = None
        self._adapter    = None    # org.bluez.Adapter1 proxy
        self._glib_loop  = None
        self._glib_thread: threading.Thread | None = None
        self._dbus       = None    # the dbus module, kept for exceptions

        # Pending pairing request state (guarded by _req_lock).
        self._req_lock     = threading.Lock()
        self._req: dict | None = None
        self._req_event    = threading.Event()
        self._req_accepted = False

    # ---- startup / shutdown -------------------------------------------------

    def start(self) -> None:
        """Initialise the GLib loop and register the BlueZ agent.  Call once at startup."""
        try:
            import dbus  # noqa: PLC0415
            import dbus.mainloop.glib  # noqa: PLC0415
            from gi.repository import GLib  # noqa: PLC0415  # isort: skip
        except ImportError as exc:
            log.warning("bluetooth: python3-dbus/gi not available (%s) — BT disabled", exc)
            return

        try:
            dbus.mainloop.glib.DBusGMainLoop(set_as_default=True)
            bus = dbus.SystemBus()
            # Probe: will raise if org.bluez service isn't running.
            bus.get_object("org.bluez", "/")
        except Exception as exc:
            log.warning("bluetooth: org.bluez not available (%s) — BT disabled", exc)
            return

        try:
            self._dbus = dbus
            self._bus  = bus

            # Find the first Bluetooth adapter.
            objs = self._get_managed_objects()
            adapter_path = next(
                (p for p, ifaces in objs.items() if "org.bluez.Adapter1" in ifaces),
                None,
            )
            if adapter_path is None:
                log.warning("bluetooth: no Bluetooth adapter found — BT disabled")
                return

            adapter_obj   = bus.get_object("org.bluez", adapter_path)
            self._adapter = dbus.Interface(adapter_obj, "org.bluez.Adapter1")

            # Register our Agent1.
            AgentClass  = _make_agent_class(dbus)
            self._agent = AgentClass(bus, _AGENT_PATH, self)
            agent_mgr_obj = bus.get_object("org.bluez", "/org/bluez")
            agent_mgr     = dbus.Interface(agent_mgr_obj, "org.bluez.AgentManager1")
            agent_mgr.RegisterAgent(_AGENT_PATH, _CAPABILITY)
            agent_mgr.RequestDefaultAgent(_AGENT_PATH)

            # Start GLib loop in background thread.
            self._glib_loop  = GLib.MainLoop()
            self._glib_thread = threading.Thread(
                target=self._glib_loop.run, daemon=True, name="bluez-glib",
            )
            self._glib_thread.start()

            self.available = True
            log.info("bluetooth: agent registered on %s (capability=%s)", adapter_path, _CAPABILITY)
        except Exception as exc:
            log.warning("bluetooth: init failed (%s) — BT disabled", exc)

    def stop(self) -> None:
        """Unregister the agent and stop the GLib loop."""
        if self._glib_loop is not None:
            self._glib_loop.quit()
        if self._bus is not None and self._available:
            try:
                agent_mgr_obj = self._bus.get_object("org.bluez", "/org/bluez")
                agent_mgr     = self._dbus.Interface(agent_mgr_obj, "org.bluez.AgentManager1")
                agent_mgr.UnregisterAgent(_AGENT_PATH)
            except Exception:
                pass

    # ---- device API ---------------------------------------------------------

    def _get_managed_objects(self) -> dict:
        """Return {path: {iface: {prop: val}}} from org.freedesktop.DBus.ObjectManager."""
        root = self._bus.get_object("org.bluez", "/")
        mgr  = self._dbus.Interface(root, "org.freedesktop.DBus.ObjectManager")
        return mgr.GetManagedObjects()

    def _device_info_by_path(self, path: str) -> dict:
        """Return a device info dict for a BlueZ device path."""
        try:
            obj   = self._bus.get_object("org.bluez", path)
            props = self._dbus.Interface(obj, "org.freedesktop.DBus.Properties")
            p     = props.GetAll("org.bluez.Device1")
            return {
                "address":   str(p.get("Address", "")),
                "name":      str(p.get("Name", p.get("Alias", "Unknown"))),
                "paired":    bool(p.get("Paired",    False)),
                "connected": bool(p.get("Connected", False)),
                "trusted":   bool(p.get("Trusted",   False)),
                "rssi":      int(p["RSSI"]) if "RSSI" in p else None,
            }
        except Exception:
            return {"address": path, "name": "Unknown", "paired": False,
                    "connected": False, "trusted": False, "rssi": None}

    def list_devices(self) -> list[dict]:
        """Return all known BlueZ devices (paired + recently discovered)."""
        objs = self._get_managed_objects()
        return [
            self._device_info_by_path(path)
            for path, ifaces in objs.items()
            if "org.bluez.Device1" in ifaces
        ]

    def start_scan(self) -> None:
        """Start Bluetooth device discovery; BlueZ auto-stops after _SCAN_TIMEOUT s."""
        props = self._dbus.Interface(
            self._bus.get_object("org.bluez", self._adapter.object_path),
            "org.freedesktop.DBus.Properties",
        )
        props.Set("org.bluez.Adapter1", "Discoverable", self._dbus.Boolean(False))
        self._adapter.SetDiscoveryFilter({"Transport": self._dbus.String("bredr+le")})
        self._adapter.StartDiscovery()

    def stop_scan(self) -> None:
        """Stop device discovery."""
        with contextlib.suppress(Exception):
            self._adapter.StopDiscovery()

    def _device_proxy(self, address: str):
        """Return the org.bluez.Device1 D-Bus interface for the given MAC address."""
        objs = self._get_managed_objects()
        for path, ifaces in objs.items():
            if "org.bluez.Device1" in ifaces:
                d = ifaces["org.bluez.Device1"]
                if str(d.get("Address", "")) == address:
                    obj = self._bus.get_object("org.bluez", path)
                    return self._dbus.Interface(obj, "org.bluez.Device1"), path
        raise KeyError(f"device {address!r} not found")

    def pair(self, address: str) -> None:
        """Initiate pairing with a device (may trigger RequestConfirmation callback)."""
        dev, _ = self._device_proxy(address)
        dev.Pair()

    def connect(self, address: str) -> None:
        """Connect to a paired device."""
        dev, _ = self._device_proxy(address)
        dev.Connect()

    def disconnect(self, address: str) -> None:
        """Disconnect from a connected device."""
        dev, _ = self._device_proxy(address)
        dev.Disconnect()

    def remove(self, address: str) -> None:
        """Remove a paired device (forget it)."""
        _, path = self._device_proxy(address)
        self._adapter.RemoveDevice(path)

    def pending_request(self) -> dict | None:
        """Return the currently pending pairing request, or None."""
        with self._req_lock:
            return dict(self._req) if self._req else None

    def respond(self, accept: bool) -> bool:
        """Accept or reject the pending pairing request.  Returns False if none pending."""
        with self._req_lock:
            if self._req is None:
                return False
            self._req_accepted = accept
        self._req_event.set()
        return True


# ---------------------------------------------------------------------------
# Starlette route factory
# ---------------------------------------------------------------------------

def make_bluetooth_router(sessions: dict, users: dict | None = None) -> list:
    """Return Starlette Route list for user-facing Bluetooth endpoints."""
    mgr = BlueZManager()

    def _require_bt(request: Request) -> tuple[bool, JSONResponse | None]:
        """Check session + BT permission; return (ok, error_response)."""
        if not mgr.available:
            return False, JSONResponse(
                {"error": "bluetooth not available"}, status_code=503,
            )
        sid = request.cookies.get("__Host-zik-session")
        if not sid or sid not in sessions:
            return False, JSONResponse({"error": "forbidden"}, status_code=403)
        s = sessions[sid]
        user = s.get("user")
        if s.get("is_admin"):
            return True, None   # admin always allowed
        if users is not None and user in users and not users[user].bluetooth:
            return False, JSONResponse(
                {"error": "bluetooth disabled for this user"}, status_code=403,
            )
        return True, None

    async def list_devices(request: Request) -> JSONResponse:
        """GET /api/bluetooth/devices — list known devices."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        try:
            return JSONResponse(mgr.list_devices())
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    async def scan(request: Request) -> JSONResponse:
        """POST /api/bluetooth/scan — start or stop discovery. Body: {"on": bool}."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        body = await request.json()
        try:
            if body.get("on"):
                mgr.start_scan()
            else:
                mgr.stop_scan()
            return JSONResponse({"ok": True})
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    async def pair_device(request: Request) -> JSONResponse:
        """POST /api/bluetooth/pair — initiate pairing. Body: {"address": "..."}."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        body = await request.json()
        address = body.get("address", "")
        try:
            mgr.pair(address)
            return JSONResponse({"ok": True})
        except KeyError:
            return JSONResponse({"error": "device not found"}, status_code=404)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    async def connect_device(request: Request) -> JSONResponse:
        """POST /api/bluetooth/connect — connect to paired device."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        body = await request.json()
        try:
            mgr.connect(body.get("address", ""))
            return JSONResponse({"ok": True})
        except KeyError:
            return JSONResponse({"error": "device not found"}, status_code=404)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    async def disconnect_device(request: Request) -> JSONResponse:
        """POST /api/bluetooth/disconnect — disconnect from device."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        body = await request.json()
        try:
            mgr.disconnect(body.get("address", ""))
            return JSONResponse({"ok": True})
        except KeyError:
            return JSONResponse({"error": "device not found"}, status_code=404)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    async def remove_device(request: Request) -> JSONResponse:
        """POST /api/bluetooth/remove — remove (forget) a paired device."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        body = await request.json()
        try:
            mgr.remove(body.get("address", ""))
            return JSONResponse({"ok": True})
        except KeyError:
            return JSONResponse({"error": "device not found"}, status_code=404)
        except Exception as exc:
            return JSONResponse({"error": str(exc)}, status_code=500)

    async def get_pairing_request(request: Request) -> JSONResponse:
        """GET /api/bluetooth/pairing-request — return pending request or null."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        return JSONResponse(mgr.pending_request())

    async def respond_pairing(request: Request) -> JSONResponse:
        """POST /api/bluetooth/pairing-request/respond — {"accept": bool}."""
        ok, err = _require_bt(request)
        if not ok:
            return err  # type: ignore[return-value]
        body = await request.json()
        if not mgr.respond(bool(body.get("accept"))):
            return JSONResponse({"error": "no pending pairing request"}, status_code=409)
        return JSONResponse({"ok": True})

    # Start the BlueZ background thread when the router is created.
    mgr.start()

    return [
        Route("/api/bluetooth/devices",                   list_devices),
        Route("/api/bluetooth/scan",                      scan,             methods=["POST"]),
        Route("/api/bluetooth/pair",                      pair_device,      methods=["POST"]),
        Route("/api/bluetooth/connect",                   connect_device,   methods=["POST"]),
        Route("/api/bluetooth/disconnect",                disconnect_device, methods=["POST"]),
        Route("/api/bluetooth/remove",                    remove_device,    methods=["POST"]),
        Route("/api/bluetooth/pairing-request",           get_pairing_request),
        Route("/api/bluetooth/pairing-request/respond",   respond_pairing,  methods=["POST"]),
    ]
