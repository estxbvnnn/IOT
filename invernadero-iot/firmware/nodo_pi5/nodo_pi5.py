#!/usr/bin/env python3
"""
NODO DEL INVERNADERO - Raspberry Pi 5  (monitoreo y riego automatico)
DHT22 + YL-38 (salida digital DO) + bomba por rele  ->  dashboard (Supabase)

Es el MISMO nodo que el de la NodeMCU y el de la Pico W (firmware/nododefinitivo): mismas reglas de riego
(riego.h), mismo protocolo con el dashboard (docs/contrato-api.md), riego automatico activable desde el
dashboard y tabla de estado por consola. Cambia solo lo propio de la placa: pines, lectura del suelo y del DHT22.

CONEXIONES (numeros BCM = GPIO; "pin" = numero fisico del conector de 40 pines)
    DHT22        +  -> pin 1 (3V3)    OUT -> pin 7  (GPIO4)    -  -> pin 9 (GND)
    YL-38        VCC-> pin 13 (GPIO27)  DO -> pin 15 (GPIO22)   GND-> pin 14 (GND)   AO: sin conectar
    Rele         DC+-> pin 2 (5V)     DC- -> pin 6 (GND)       IN -> pin 11 (GPIO17)   (jumper del rele en H)
    Bomba        fuente(+) -> COM ; NO -> cable rojo ; cable negro -> fuente(-) ; diodo 1N4007 en paralelo

SUELO: la Pi 5 no tiene entradas analogicas, asi que se lee la salida digital DO del YL-38 (la umbral se ajusta
con el potenciometro azul del modulo). DO dice solo "seco" o "humedo": el nodo informa SUELO_RAW_SECO o
SUELO_RAW_HUMEDO (0-1023) para que el dashboard y sus umbrales sigan funcionando. Con un ADS1115 se podria
leer el valor real (no incluido).

INSTALACION (Raspberry Pi OS Bookworm)
    sudo apt update && sudo apt install -y python3-lgpio python3-venv libgpiod2
    python3 -m venv --system-site-packages ~/venv-nodo && source ~/venv-nodo/bin/activate
    pip install adafruit-circuitpython-dht
    SERVER_URL=http://IP_DEL_PC:3000 DEVICE_TOKEN=el_token python3 nodo_pi5.py
  Sin DEVICE_TOKEN (o con el de ejemplo) el nodo funciona solo en modo local, sin conectarse al dashboard.
  Para correr al arrancar, ver nodo_pi5.service. Para probar sin hardware:  python3 nodo_pi5.py --simulado

CONSOLA (si hay teclado): r = regar 10 s | p = parar | s = estado
"""
import argparse
import collections
import dataclasses
import json
import math
import os
import random
import re
import secrets
import signal
import sys
import threading
import time
import urllib.error
import urllib.request

# ===================================================================================================
#  CONFIGURACION DEL USUARIO (tambien se puede fijar con variables de entorno del mismo nombre)
# ===================================================================================================
SERVER_URL = os.environ.get("SERVER_URL", "http://10.12.34.112:3000")      # SIN barra final
DEVICE_TOKEN = os.environ.get("DEVICE_TOKEN", "PEGAR_AQUI_EL_TOKEN_DEL_NODO")
TABLA_S = int(os.environ.get("TABLA_S", "10"))                  # segundos entre filas de la tabla (0 = sin tabla)

# Pines (numeros BCM)
PIN_DHT = 4
PIN_SUELO_VCC = 27
PIN_SUELO_DO = 22
PIN_RELE = 17
RELE_ACTIVO_EN_BAJO = False        # jumper del rele en H -> False
SUELO_DO_SECO_ES_ALTO = True       # el YL-38 pone DO en alto cuando el suelo esta SECO (ver el LED del modulo)
SUELO_RAW_SECO = 1000              # lectura que se informa cuando DO dice "seco"  (>= suelo_on)
SUELO_RAW_HUMEDO = 400             # lectura que se informa cuando DO dice "humedo" (banda OPTIMO)

FW_VERSION = "1.0.0-pi5"
ESTADO_ARCHIVO = os.path.expanduser("~/.nodo_pi5_cfg.json")
BOMBA_ARCHIVO = os.path.expanduser("~/.nodo_pi5_bomba")
DHT_VALIDO_S = 30                  # una lectura del DHT22 vale hasta 30 s
HTTP_TIMEOUT_S = 8
MUESTREO_RIEGO_S = 5               # mientras la bomba esta encendida se mide cada 5 s

# ===================================================================================================
#  RIEGO  (port de riego.h: logica pura, probada en test_nodo_pi5.py)
# ===================================================================================================
INTERVALO_MIN_S, INTERVALO_MAX_S = 5, 3600
SUELO_MAX_RAW = 1023
TEMP_MAX_MIN, TEMP_MAX_MAX = 30.0, 60.0
RIEGO_MAX_MIN_S, RIEGO_MAX_MAX_S = 5, 120
ESPERA_MIN_S, ESPERA_MAX_S = 60, 3600
ORDEN_DUR_MIN_S, ORDEN_DUR_MAX_S = 5, 120
COLA_MAX = 8
IDS_RECORDADOS = 8
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,39}$")

BANDAS = ("SATURADO", "OPTIMO", "SECO")


@dataclasses.dataclass
class Config:
    ver: int = 0
    intervalo_s: int = 300
    suelo_on: int = 700
    suelo_off: int = 500
    suelo_sat: int = 300
    temp_max: float = 40.0
    riego_max_s: int = 30
    espera_s: int = 300
    auto_riego: bool = True


def config_valida(c: Config) -> bool:
    if not (INTERVALO_MIN_S <= c.intervalo_s <= INTERVALO_MAX_S):
        return False
    if c.suelo_sat < 1 or c.suelo_on > SUELO_MAX_RAW:
        return False
    if not (c.suelo_sat < c.suelo_off < c.suelo_on):
        return False
    if not (TEMP_MAX_MIN <= c.temp_max <= TEMP_MAX_MAX):      # falso tambien con NaN
        return False
    if not (RIEGO_MAX_MIN_S <= c.riego_max_s <= RIEGO_MAX_MAX_S):
        return False
    if not (ESPERA_MIN_S <= c.espera_s <= ESPERA_MAX_S):
        return False
    return True


@dataclasses.dataclass
class Lectura:
    suelo_ok: bool = False
    suelo_raw: int = 0
    temp_ok: bool = False
    temp: float = 0.0


class Controlador:
    """Decide cuando regar. El reloj lo entrega quien llama (milisegundos monotonicos)."""

    def __init__(self, ahora_ms: int = 0, riego_interrumpido: bool = False):
        self.cfg = Config()
        self.lec = Lectura()
        self.hay_lectura = False
        self.sin_bomba = False
        self.bomba = False
        self.manual = False
        self.manual_ignora_suelo = False
        self.dur_orden_ms = 0
        self.t_inicio = 0
        self.cmd_activa = ""
        self.espera_activa = False
        self.t_fin = 0
        self.muestra_pendiente = False
        self.eventos: list[dict] = []
        self.ev_seq = 0
        self.acks: list[dict] = []
        self.ack_seq = 0
        self.ids = collections.deque(maxlen=IDS_RECORDADOS)
        self.reloj = ahora_ms
        if riego_interrumpido:                                   # arranque tras un corte con la bomba encendida
            self.espera_activa = True
            self.t_fin = ahora_ms
            self._encolar_evento(False, "seguridad", 0, "")

    # ---- configuracion
    def aplicar_config(self, nueva: Config) -> bool:
        if not config_valida(nueva):
            return False
        self.cfg = nueva
        return True

    # ---- tiempo
    def tick(self, ahora_ms: int) -> None:
        self.reloj = ahora_ms
        if self.bomba:
            trans = ahora_ms - self.t_inicio
            if self.manual and trans >= self.dur_orden_ms:
                self._apagar("orden", self.cmd_activa)
            elif trans >= self.cfg.riego_max_s * 1000:
                self._apagar("tiempo_max", self.cmd_activa)
        elif self.espera_activa:
            if ahora_ms - self.t_fin >= self.cfg.espera_s * 1000:
                self.espera_activa = False
                # si la ultima lectura pedia riego, se mide de nuevo YA: nunca se decide con una lectura vieja
                if self.hay_lectura and self.lec.suelo_ok and self.lec.suelo_raw >= self.cfg.suelo_on:
                    self.muestra_pendiente = True

    def nueva_lectura(self, l: Lectura, ahora_ms: int) -> None:
        self.reloj = ahora_ms
        self.lec = dataclasses.replace(l)
        if self.lec.suelo_ok and not (0 <= self.lec.suelo_raw <= SUELO_MAX_RAW):
            self.lec.suelo_ok = False
        if self.lec.temp_ok and (math.isnan(self.lec.temp) or not (-40.0 <= self.lec.temp <= 80.0)):
            self.lec.temp_ok = False
        self.hay_lectura = True
        self.muestra_pendiente = False
        self._evaluar()

    # ---- ordenes del servidor (o locales, con id vacio)
    def atender_orden(self, o: dict, ahora_ms: int) -> dict:
        self.reloj = ahora_ms
        r = {"ignorada": False, "ejecutada": False, "detalle": ""}
        oid = o.get("id", "")
        if oid:
            if oid in self.ids:
                r["ignorada"] = True
                return r
            self.ids.append(oid)
        tipo = o.get("tipo")
        if tipo not in ("riego", "parar"):
            return self._terminar(o, False, "tipo de orden desconocido", r)
        if tipo == "parar":                                      # detener siempre es seguro: se ejecuta aunque haya vencido
            if self.bomba:
                self._apagar("orden", oid or self.cmd_activa)
                return self._terminar(o, True, "bomba apagada", r)
            return self._terminar(o, True, "ya estaba apagada", r)

        desde = max(0, ahora_ms - o.get("recibida_ms", ahora_ms))
        if desde >= o.get("vence_s", 0) * 1000:
            return self._terminar(o, False, "vencida", r)
        if self.sin_bomba:
            return self._terminar(o, False, "nodo sin bomba", r)
        dur = o.get("dur_s", 0)
        if not (ORDEN_DUR_MIN_S <= dur <= ORDEN_DUR_MAX_S):
            return self._terminar(o, False, f"duracion invalida ({ORDEN_DUR_MIN_S}-{ORDEN_DUR_MAX_S} s)", r)
        if self.bomba:
            return self._terminar(o, False, "ya esta regando", r)
        if self.espera_activa:
            return self._terminar(o, False, f"en espera entre riegos (faltan {self.espera_restante_s()} s)", r)
        if self.hay_lectura and self.lec.suelo_ok and self.lec.suelo_raw < self.cfg.suelo_sat:
            return self._terminar(o, False, "suelo saturado", r)

        acortada = dur > self.cfg.riego_max_s
        if acortada:
            dur = self.cfg.riego_max_s
        sin_sensor = not (self.hay_lectura and self.lec.suelo_ok)   # si el sensor ya estaba en falla, el operador decide
        self._encender("manual", dur * 1000, oid, sin_sensor)
        if acortada:
            det = f"regando {dur} s (acortada por el maximo)"
        elif sin_sensor:
            det = f"regando {dur} s (suelo sin lectura)"
        else:
            det = f"regando {dur} s"
        return self._terminar(o, True, det, r)

    # ---- consulta
    def estado(self) -> str:
        if self.bomba:
            return "riego"
        if not self.hay_lectura or not self.lec.suelo_ok:
            return "bloq_sensor"
        if self.lec.suelo_raw < self.cfg.suelo_sat:
            return "saturado"
        if self.espera_activa:
            return "espera"
        if self.lec.suelo_raw >= self.cfg.suelo_on and (not self.lec.temp_ok or self.lec.temp > self.cfg.temp_max):
            return "bloq_temp"
        return "idle"

    def espera_restante_s(self) -> int:
        if not self.espera_activa or self.bomba:
            return 0
        total = self.cfg.espera_s * 1000
        pasado = self.reloj - self.t_fin
        if pasado >= total:
            return 0
        return -(-(total - pasado) // 1000)                      # redondeo hacia arriba

    def riego_s(self) -> int:
        return (self.reloj - self.t_inicio) // 1000 if self.bomba else 0

    def banda(self, raw: int) -> str:
        if raw < self.cfg.suelo_sat:
            return BANDAS[0]
        if raw >= self.cfg.suelo_on:
            return BANDAS[2]
        return BANDAS[1]

    def quiere_muestra_ya(self) -> bool:
        q = self.muestra_pendiente
        self.muestra_pendiente = False
        return q

    def ago_evento_s(self, e: dict) -> int:
        return min(86400, max(0, (self.reloj - e["t_ms"]) // 1000))

    def descartar_hasta(self, ev_seq: int, ack_seq: int) -> None:
        self.eventos = [e for e in self.eventos if e["seq"] > ev_seq]
        self.acks = [a for a in self.acks if a["seq"] > ack_seq]

    def vaciar_colas(self) -> None:
        self.eventos.clear()
        self.acks.clear()

    # ---- internos
    def _evaluar(self) -> None:
        if self.bomba:
            if not self.lec.suelo_ok:
                if not (self.manual and self.manual_ignora_suelo):
                    self._apagar("seguridad", self.cmd_activa)
                return
            if self.manual:
                if not self.manual_ignora_suelo and self.lec.suelo_raw < self.cfg.suelo_sat:
                    self._apagar("saturado", self.cmd_activa)
            elif self.lec.suelo_raw <= self.cfg.suelo_off:
                self._apagar("objetivo", self.cmd_activa)
            return
        if not self.cfg.auto_riego:                              # riego automatico desactivado desde el dashboard
            return
        if not self.lec.suelo_ok:
            return
        if self.lec.suelo_raw < self.cfg.suelo_on:
            return
        if self.lec.suelo_raw < self.cfg.suelo_sat:
            return
        if not self.lec.temp_ok:
            return
        if self.lec.temp > self.cfg.temp_max:
            return
        if self.espera_activa:
            return
        self._encender("auto", 0, "", False)

    def _encender(self, motivo: str, dur_orden_ms: int, cmd: str, ignora_suelo: bool) -> None:
        self.bomba = True
        self.manual = motivo == "manual"
        self.manual_ignora_suelo = self.manual and ignora_suelo
        self.dur_orden_ms = dur_orden_ms
        self.t_inicio = self.reloj
        self.cmd_activa = cmd
        self._encolar_evento(True, motivo, 0, cmd)

    def _apagar(self, motivo: str, cmd: str) -> None:
        s = min(65535, (self.reloj - self.t_inicio + 500) // 1000)
        self.bomba = False
        self.manual = False
        self.manual_ignora_suelo = False
        self.cmd_activa = ""
        self.espera_activa = True                                # empieza la espera entre riegos
        self.t_fin = self.reloj
        self._encolar_evento(False, motivo, s, cmd)

    def _encolar_evento(self, encendido: bool, motivo: str, dur_s: int, cmd: str) -> None:
        if len(self.eventos) >= COLA_MAX:
            self.eventos.pop(0)
        self.ev_seq += 1
        self.eventos.append({"seq": self.ev_seq, "encendido": encendido, "motivo": motivo,
                             "t_ms": self.reloj, "dur_s": dur_s, "cmd": cmd})

    def _terminar(self, o: dict, ejecutada: bool, detalle: str, r: dict) -> dict:
        r["ejecutada"] = ejecutada
        r["detalle"] = detalle[:55]
        if o.get("id"):                                          # las ordenes locales no se acusan
            if len(self.acks) >= COLA_MAX:
                self.acks.pop(0)
            self.ack_seq += 1
            self.acks.append({"seq": self.ack_seq, "id": o["id"], "ejecutada": ejecutada, "detalle": r["detalle"]})
        return r


# ===================================================================================================
#  ENVIO (port de envio.h): cuando enviar y que hacer con cada resultado
# ===================================================================================================
SEPARACION_MIN_MS = 2000
INTENTOS_MAX = 3
PASO_REINTENTO_MS = 3000
BACKOFF_BASE_MS, BACKOFF_MAX_MS, BACKOFF_MIN_MS = 10000, 300000, 5000
ESPERA_401_MS = 60000
ESPERA_429_DEF_MS, ESPERA_429_MAX_MS = 30000, 600000
RECHAZOS_PARA_LIMPIAR = 3


class Plan:
    NADA, ENVIAR_NUEVA, REENVIAR = 0, 1, 2
    EXITO, REINTENTAR, DESCARTAR, DESCARTAR_Y_LIMPIAR = 0, 1, 2, 3

    def __init__(self, ahora_ms: int = 0):
        self.en_vuelo = False
        self.pendiente = False
        self.penalizado = False
        self.enviado_alguna_vez = False
        self.intentos = 0
        self.fallos_seguidos = 0
        self.rechazos = 0
        self.t_ultimo_envio = ahora_ms
        self.t_ref = ahora_ms
        self.espera_ms = 0          # la primera trama sale apenas haya datos y red

    def decidir(self, ahora_ms: int, listo: bool, hay_novedades: bool) -> int:
        if self.en_vuelo or not listo:
            return Plan.NADA
        if self.enviado_alguna_vez and ahora_ms - self.t_ultimo_envio < SEPARACION_MIN_MS:
            return Plan.NADA
        vencio = ahora_ms - self.t_ref >= self.espera_ms
        if self.pendiente:
            return Plan.REENVIAR if vencio else Plan.NADA
        if not self.penalizado and hay_novedades:
            return Plan.ENVIAR_NUEVA
        return Plan.ENVIAR_NUEVA if vencio else Plan.NADA

    def entregada(self, ahora_ms: int) -> None:
        if not self.pendiente:
            self.pendiente = True
            self.intentos = 0
        self.intentos += 1
        self.en_vuelo = True
        self.t_ultimo_envio = ahora_ms
        self.enviado_alguna_vez = True

    def respuesta(self, ahora_ms: int, http: int, cuerpo_ok: bool, retry_after_s: int, intervalo_ms: int) -> int:
        self.en_vuelo = False
        if http == 200 and cuerpo_ok:
            self.pendiente = False
            self.penalizado = False
            self.fallos_seguidos = 0
            self.rechazos = 0
            self.t_ref = ahora_ms
            self.espera_ms = intervalo_ms
            return Plan.EXITO
        self.penalizado = True
        self.t_ref = ahora_ms
        if http == 401:
            self.pendiente = False
            self.espera_ms = ESPERA_401_MS
            return Plan.DESCARTAR
        if http == 429:
            self.pendiente = False
            ms = retry_after_s * 1000 if retry_after_s else ESPERA_429_DEF_MS
            self.espera_ms = min(ms, ESPERA_429_MAX_MS)
            return Plan.DESCARTAR
        if http in (400, 413):
            self.pendiente = False
            self.espera_ms = BACKOFF_BASE_MS
            self.rechazos += 1
            if self.rechazos >= RECHAZOS_PARA_LIMPIAR:
                self.rechazos = 0
                return Plan.DESCARTAR_Y_LIMPIAR
            return Plan.DESCARTAR
        if self.intentos < INTENTOS_MAX:                         # falla transitoria: se reintenta la MISMA trama
            self.espera_ms = self.intentos * PASO_REINTENTO_MS
            return Plan.REINTENTAR
        self.pendiente = False
        self.fallos_seguidos = min(250, self.fallos_seguidos + 1)
        b = BACKOFF_BASE_MS
        for _ in range(1, self.fallos_seguidos):
            if b >= BACKOFF_MAX_MS:
                break
            b *= 2
        self.espera_ms = max(BACKOFF_MIN_MS, min(b, BACKOFF_MAX_MS, intervalo_ms))
        return Plan.DESCARTAR


# ===================================================================================================
#  PROTOCOLO (port de protocolo.h)
# ===================================================================================================
def construir_trama(ctl: Controlador, boot: int, seq: int, up_s: int, ultima: dict, fallas: list) -> tuple[dict, int, int]:
    """Devuelve (trama, ultimo seq de evento enviado, ultimo seq de ack enviado)."""
    def num(ok, v, nd):
        return round(float(v), nd) if ok else None

    ev = []
    for e in ctl.eventos[:COLA_MAX]:
        d = {"t": "pump_on" if e["encendido"] else "pump_off", "why": e["motivo"], "ago": ctl.ago_evento_s(e)}
        if not e["encendido"]:
            d["dur"] = e["dur_s"]
        if e["cmd"]:
            d["cmd"] = e["cmd"]
        ev.append(d)
    acks = [{"id": a["id"], "estado": "ejecutada" if a["ejecutada"] else "rechazada", "detalle": a["detalle"]}
            for a in ctl.acks[:COLA_MAX]]
    t = {
        "v": 1, "fw": FW_VERSION, "boot": boot, "seq": seq, "up": up_s,
        "temp": num(ultima["temp_ok"], ultima["temp"], 1),
        "hum_aire": num(ultima["hum_ok"], ultima["hum"], 1),
        "suelo_raw": int(ultima["suelo_raw"]) if ultima["suelo_ok"] else None,
        "bomba": 1 if ctl.bomba else 0,
        "riego_s": ctl.riego_s(), "est": ctl.estado(), "esp": ctl.espera_restante_s(),
        "fallas": fallas[:6],
    }
    if ev:
        t["ev"] = ev
    if acks:
        t["acks"] = acks
    return t, (ctl.eventos[:COLA_MAX][-1]["seq"] if ev else 0), (ctl.acks[:COLA_MAX][-1]["seq"] if acks else 0)


def parsear_respuesta(texto: str, actual: Config) -> dict | None:
    """Devuelve {ok, dup, cfg (Config nueva o None), cfg_invalida, ordenes[]} o None si no es un JSON objeto valido."""
    try:
        doc = json.loads(texto)
    except (ValueError, TypeError):
        return None
    if not isinstance(doc, dict):
        return None
    r = {"ok": doc.get("ok") is True, "dup": doc.get("dup") is True, "cfg": None, "cfg_invalida": False, "ordenes": []}
    c = doc.get("cfg")
    if isinstance(c, dict):
        m = dataclasses.replace(actual)
        inval = False

        def entero(k, lo, hi):
            nonlocal inval
            v = c.get(k)
            if v is None:
                return None
            if isinstance(v, bool) or not isinstance(v, int) or not (lo <= v <= hi):
                inval = True
                return None
            return v

        for campo, clave in (("ver", "ver"), ("intervalo_s", "intervalo_s"), ("suelo_on", "suelo_on"), ("suelo_off", "suelo_off"),
                             ("suelo_sat", "suelo_sat"), ("riego_max_s", "riego_max_s"), ("espera_s", "espera_s")):
            v = entero(clave, 0, 0xFFFFFFFF if clave == "ver" else 65535)
            if v is not None:
                setattr(m, campo, v)
        tm = c.get("temp_max")
        if tm is not None:
            if isinstance(tm, bool) or not isinstance(tm, (int, float)):
                inval = True
            else:
                m.temp_max = float(tm)
        au = c.get("auto")
        if au is not None:
            if isinstance(au, bool):
                m.auto_riego = au
            elif isinstance(au, int):
                m.auto_riego = au != 0
            else:
                inval = True
        if inval or not config_valida(m):
            r["cfg_invalida"] = True
        else:
            r["cfg"] = m
    for item in (doc.get("ordenes") or [])[:4]:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not ID_RE.match(item["id"]):
            continue
        tipo = item.get("tipo")
        o = {"id": item["id"], "tipo": tipo if tipo in ("riego", "parar") else "desconocido"}
        dur = item.get("dur_s")
        o["dur_s"] = dur if isinstance(dur, int) and not isinstance(dur, bool) and 0 <= dur <= 65535 else 0
        vence = item.get("vence_s")
        o["vence_s"] = vence if isinstance(vence, int) and not isinstance(vence, bool) and 0 <= vence <= 4000000 else 0
        r["ordenes"].append(o)
    return r


def post_ingest(url: str, token: str, cuerpo: str, timeout: float = HTTP_TIMEOUT_S) -> tuple[int, str, int]:
    """POST de una trama. Devuelve (codigo http o -1 si no hubo respuesta, cuerpo, Retry-After)."""
    req = urllib.request.Request(
        url.rstrip("/") + "/api/ingest", data=cuerpo.encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {token}",
                 "User-Agent": f"nodo-invernadero/{FW_VERSION}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read(65536).decode("utf-8", "replace"), 0
    except urllib.error.HTTPError as e:
        try:
            retry = int(e.headers.get("Retry-After", "0") or 0)
        except ValueError:
            retry = 0
        return e.code, e.read(4096).decode("utf-8", "replace"), max(0, min(retry, 3600))
    except (urllib.error.URLError, OSError, TimeoutError):
        return -1, "", 0


# ===================================================================================================
#  HARDWARE
# ===================================================================================================
class HardwareLgpio:
    """Rele, alimentacion y salida digital del YL-38 con lgpio (el unico acceso a GPIO que funciona en la Pi 5)."""

    def __init__(self):
        import lgpio                                              # paquete apt: python3-lgpio
        self.lg = lgpio
        self.h = None
        for chip in (4, 0):                                       # en la Pi 5 el conector esta en gpiochip4 (o 0 en kernels nuevos)
            try:
                self.h = lgpio.gpiochip_open(chip)
                lgpio.gpio_claim_output(self.h, PIN_RELE, self._nivel_rele(False))
                break
            except Exception:                                     # noqa: BLE001
                if self.h is not None:
                    try:
                        lgpio.gpiochip_close(self.h)
                    except Exception:                             # noqa: BLE001
                        pass
                    self.h = None
        if self.h is None:
            raise RuntimeError("No se pudo abrir el GPIO (gpiochip4/gpiochip0): instale python3-lgpio y ejecute en la Pi 5")
        lgpio.gpio_claim_output(self.h, PIN_SUELO_VCC, 0)
        self.dht = None
        try:
            import adafruit_dht, board                            # pip: adafruit-circuitpython-dht
            self.dht = adafruit_dht.DHT22(getattr(board, f"D{PIN_DHT}"), use_pulseio=False)
        except Exception as e:                                    # noqa: BLE001
            print(f"AVISO: DHT22 no disponible ({e}); instale: pip install adafruit-circuitpython-dht", flush=True)

    @staticmethod
    def _nivel_rele(encendida: bool) -> int:
        return (0 if RELE_ACTIVO_EN_BAJO else 1) if encendida else (1 if RELE_ACTIVO_EN_BAJO else 0)

    def rele(self, encendida: bool) -> None:
        self.lg.gpio_write(self.h, PIN_RELE, self._nivel_rele(encendida))

    def _leer_do(self, pull) -> bool:
        lg = self.lg
        lg.gpio_claim_input(self.h, PIN_SUELO_DO, pull)
        time.sleep(0.003)
        altos = sum(lg.gpio_read(self.h, PIN_SUELO_DO) for _ in range(10))
        lg.gpio_free(self.h, PIN_SUELO_DO)
        return altos >= 5

    def medir_suelo(self) -> tuple[bool, int]:
        """(ok, raw 0-1023). Si DO sigue a la resistencia interna (arriba/abajo) esta SIN conectar: falla del sensor."""
        lg = self.lg
        lg.gpio_write(self.h, PIN_SUELO_VCC, 1)                   # el modulo solo se energiza al medir (evita la corrosion)
        try:
            time.sleep(0.2)
            alto_pd = self._leer_do(lg.SET_PULL_DOWN)
            alto_pu = self._leer_do(lg.SET_PULL_UP)
        finally:
            lg.gpio_write(self.h, PIN_SUELO_VCC, 0)
        if alto_pd != alto_pu:
            return False, 0
        seco = alto_pd == SUELO_DO_SECO_ES_ALTO
        return True, SUELO_RAW_SECO if seco else SUELO_RAW_HUMEDO

    def leer_dht(self) -> tuple[bool, float, float]:
        if self.dht is None:
            return False, 0.0, 0.0
        try:
            t, h = self.dht.temperature, self.dht.humidity
        except RuntimeError:                                      # el DHT22 falla seguido: es normal, se reintenta
            return False, 0.0, 0.0
        if t is None or h is None or not (-40 <= t <= 80) or not (0 <= h <= 100):
            return False, 0.0, 0.0
        return True, float(t), float(h)

    def cerrar(self) -> None:
        try:
            self.rele(False)
            self.lg.gpio_write(self.h, PIN_SUELO_VCC, 0)
            self.lg.gpiochip_close(self.h)
        except Exception:                                         # noqa: BLE001
            pass
        if self.dht is not None:
            try:
                self.dht.exit()
            except Exception:                                     # noqa: BLE001
                pass


class HardwareSimulado:
    """Sin hardware: para probar el programa en cualquier PC (--simulado) y en los tests."""

    def __init__(self, suelo_raw: int = 1000, suelo_ok: bool = True, temp: float | None = 24.0, hum: float = 60.0):
        self.rele_on = False
        self.suelo_raw, self.suelo_ok = suelo_raw, suelo_ok
        self.temp, self.hum = temp, hum
        self.historial_rele: list[bool] = []

    def rele(self, encendida: bool) -> None:
        if encendida != self.rele_on:
            self.historial_rele.append(encendida)
        self.rele_on = encendida

    def medir_suelo(self) -> tuple[bool, int]:
        return self.suelo_ok, self.suelo_raw

    def leer_dht(self) -> tuple[bool, float, float]:
        if self.temp is None:
            return False, 0.0, 0.0
        return True, self.temp + random.uniform(-0.2, 0.2), self.hum

    def cerrar(self) -> None:
        self.rele(False)


# ===================================================================================================
#  NODO
# ===================================================================================================
class Nodo:
    def __init__(self, hw, url: str = SERVER_URL, token: str = DEVICE_TOKEN, enviar=post_ingest, estado_archivo: str | None = ESTADO_ARCHIVO,
                 bomba_archivo: str | None = BOMBA_ARCHIVO, tabla_s: int = TABLA_S, salida=print):
        self.hw, self.url, self.token, self.enviar = hw, url, token, enviar
        self.estado_archivo, self.bomba_archivo, self.tabla_s, self.salida = estado_archivo, bomba_archivo, tabla_s, salida
        self.t0 = time.monotonic()
        interrumpido = self._leer_marca_bomba()
        self.ctl = Controlador(self.ahora(), interrumpido)
        self._cargar_config()
        self.plan = Plan(self.ahora())
        self.boot = secrets.randbits(32)
        self.seq = 0
        self.red_activa = token != "PEGAR_AQUI_EL_TOKEN_DEL_NODO" and bool(token)
        self.msg_pend: tuple[dict, int, int] | None = None
        self.resultado = None                                     # (seq, http, texto, retry) entregado por el hilo de red
        self.lock = threading.Lock()
        self.ultima = {"hay": False, "temp_ok": False, "temp": 0.0, "hum_ok": False, "hum": 0.0, "suelo_ok": False, "suelo_raw": 0}
        self.dht_cache = (False, 0.0, 0.0, 0.0)                   # ok, t, h, instante
        self.t_ultima_muestra = 0
        self.primera_muestra = False
        self.ev_incluido_max = 0
        self.ack_incluido_max = 0
        self.red_ultima_ok = 0
        self.red_fallando = False
        self.t_tabla = self.ahora() + 3000 - self.tabla_s * 1000   # primera fila a los ~3 s
        self.filas = 0
        self.rele_previo = False
        self.avisos = set()
        self.corriendo = True
        self._dht_hilo = None
        self.aplicar_bomba(forzar=True)

    # ---- utilidades
    def ahora(self) -> int:
        return int((time.monotonic() - self.t0) * 1000)

    def log(self, msg: str) -> None:
        self.salida(msg)

    def _leer_marca_bomba(self) -> bool:
        if not self.bomba_archivo:
            return False
        try:
            with open(self.bomba_archivo) as f:
                return f.read().strip() == "1"
        except OSError:
            return False

    def _guardar_marca_bomba(self, encendida: bool) -> None:
        if self.bomba_archivo:
            try:
                with open(self.bomba_archivo, "w") as f:
                    f.write("1" if encendida else "0")
            except OSError:
                pass

    def _cargar_config(self) -> None:
        if not self.estado_archivo:
            return
        try:
            with open(self.estado_archivo) as f:
                d = json.load(f)
            c = Config(**{k: d[k] for k in dataclasses.asdict(Config()) if k in d})
            if self.ctl.aplicar_config(c):
                self.log(f"CFG: cargada de la memoria (ver {c.ver})")
            else:
                self.log("CFG: la guardada es invalida; se usan los valores por defecto")
        except (OSError, ValueError, TypeError):
            self.log("CFG: sin configuracion guardada; valores por defecto del contrato")

    def _guardar_config(self, c: Config) -> None:
        if self.estado_archivo:
            try:
                with open(self.estado_archivo, "w") as f:
                    json.dump(dataclasses.asdict(c), f)
            except OSError:
                self.log("CFG: no se pudo guardar la configuracion")

    # ---- bomba
    def aplicar_bomba(self, forzar: bool = False) -> None:
        on = self.ctl.bomba
        if forzar or on != self.rele_previo:
            self.hw.rele(on)
        if on != self.rele_previo:
            self.rele_previo = on
            self.filas = 0
            self._guardar_marca_bomba(on)
            if self.ctl.eventos:
                e = self.ctl.eventos[-1]
                self.log(f">> BOMBA ENCENDIDA ({e['motivo']})" if e["encendido"] else f">> BOMBA APAGADA ({e['motivo']}, {e['dur_s']} s)")
            else:
                self.log(">> BOMBA ENCENDIDA" if on else ">> BOMBA APAGADA")

    # ---- DHT22 en un hilo aparte (cada lectura puede tardar y falla seguido: nunca debe frenar el corte de la bomba)
    def iniciar_dht(self) -> None:
        def bucle():
            while self.corriendo:
                ok, t, h = self.hw.leer_dht()
                if ok:
                    self.dht_cache = (True, t, h, time.monotonic())
                time.sleep(2.5)                                   # el DHT22 pide >= 2 s entre lecturas
        self._dht_hilo = threading.Thread(target=bucle, daemon=True)
        self._dht_hilo.start()

    # ---- mediciones
    def hacer_ronda(self) -> None:
        s_ok, s_raw = self.hw.medir_suelo()
        ok, t, h, ts = self.dht_cache
        dht_vivo = ok and (time.monotonic() - ts) <= DHT_VALIDO_S
        u = self.ultima
        u.update(suelo_ok=s_ok, suelo_raw=s_raw, temp_ok=dht_vivo, temp=t if dht_vivo else 0.0, hum_ok=dht_vivo, hum=h if dht_vivo else 0.0, hay=True)
        self._avisar("suelo", not s_ok, "AVISO: sin lectura valida del sensor de suelo (YL-38 DO flotando: revise DO, VCC y GND)", "OK: sensor de suelo recuperado")
        self._avisar("dht", not dht_vivo, "AVISO: sin lectura valida del DHT22 (revise el cableado)", "OK: DHT22 recuperado")
        l = Lectura(suelo_ok=s_ok, suelo_raw=s_raw, temp_ok=dht_vivo, temp=u["temp"])
        self.ctl.nueva_lectura(l, self.ahora())
        self.aplicar_bomba()
        self.primera_muestra = True
        self.t_ultima_muestra = self.ahora()

    def _avisar(self, clave: str, falla: bool, msg_falla: str, msg_ok: str) -> None:
        if falla and clave not in self.avisos:
            self.avisos.add(clave)
            self.log(msg_falla + "; se avisa una sola vez")
        elif not falla and clave in self.avisos:
            self.avisos.discard(clave)
            self.log(msg_ok)

    # ---- red
    def _fallas(self) -> list:
        f = []
        if not self.ultima["suelo_ok"]:
            f.append("suelo")
        if not self.ultima["temp_ok"]:
            f.append("dht")
        return f

    def hay_novedades(self) -> bool:
        return bool(self.ctl.eventos and self.ctl.eventos[-1]["seq"] > self.ev_incluido_max) or bool(self.ctl.acks and self.ctl.acks[-1]["seq"] > self.ack_incluido_max)

    def armar_trama(self) -> None:
        self.ctl.tick(self.ahora())
        self.aplicar_bomba()
        self.seq += 1
        trama, ev_hasta, ack_hasta = construir_trama(self.ctl, self.boot, self.seq, self.ahora() // 1000, self.ultima, self._fallas())
        self.msg_pend = (trama, ev_hasta, ack_hasta)
        self.ev_incluido_max = max(self.ev_incluido_max, ev_hasta)
        self.ack_incluido_max = max(self.ack_incluido_max, ack_hasta)

    def _lanzar_post(self) -> None:
        trama = self.msg_pend[0]
        cuerpo = json.dumps(trama, separators=(",", ":"))

        def hilo():
            http, texto, retry = self.enviar(self.url, self.token, cuerpo)
            with self.lock:
                self.resultado = (trama["seq"], http, texto, retry)
        threading.Thread(target=hilo, daemon=True).start()

    def gestionar_envio(self) -> None:
        if not self.red_activa:
            return
        with self.lock:
            res, self.resultado = self.resultado, None
        if res is not None:
            self.procesar_respuesta(*res)
        ahora = self.ahora()
        intervalo_ms = self.ctl.cfg.intervalo_s * 1000
        listo = self.ultima["hay"]
        novedades = self.hay_novedades()
        a = self.plan.decidir(ahora, listo, novedades)
        if a == Plan.ENVIAR_NUEVA:
            if not novedades and ahora - self.t_ultima_muestra > 10000 and not self.ctl.bomba:
                self.hacer_ronda()                                # los datos que llegan al dashboard son recientes
            self.armar_trama()
            self.plan.entregada(self.ahora())
            self._lanzar_post()
        elif a == Plan.REENVIAR and self.msg_pend is not None:
            self.plan.entregada(self.ahora())
            self._lanzar_post()
        _ = intervalo_ms

    def procesar_respuesta(self, seq: int, http: int, texto: str, retry: int) -> None:
        if not self.plan.en_vuelo or self.msg_pend is None or seq != self.msg_pend[0]["seq"]:
            return                                                # respuesta tardia o de otra trama
        _, ev_hasta, ack_hasta = self.msg_pend
        parsed = parsear_respuesta(texto, self.ctl.cfg) if http == 200 else None
        cuerpo_ok = bool(parsed and parsed["ok"])
        if http == 200 and not cuerpo_ok:
            self.log(f"RED: respuesta 200 ilegible ({len(texto)} bytes): {texto[:160]}")
        r = self.plan.respuesta(self.ahora(), http, cuerpo_ok, retry, self.ctl.cfg.intervalo_s * 1000)
        if r == Plan.EXITO:
            self.ctl.descartar_hasta(ev_hasta, ack_hasta)
            self.red_ultima_ok, self.red_fallando = seq, False
            self._aplicar_cfg(parsed)
            self._atender_ordenes(parsed)
        elif r == Plan.REINTENTAR:
            self.red_fallando = True
            self.log(f"RED: trama {seq} fallo (HTTP {http}), se reintenta igual (intento {self.plan.intentos} de {INTENTOS_MAX})")
        elif r == Plan.DESCARTAR:
            self.red_fallando = True
            self.log(f"RED: trama {seq} descartada (HTTP {http}{': token rechazado, revise DEVICE_TOKEN' if http == 401 else ''})")
        else:
            self.red_fallando = True
            self.ctl.vaciar_colas()
            self.log(f"RED: el servidor rechaza la trama (HTTP {http}) tres veces seguidas; se vacian las colas")

    def _aplicar_cfg(self, parsed: dict) -> None:
        if parsed["cfg_invalida"]:
            self.log("CFG: la del servidor es INVALIDA; se ignora completa")
            return
        c = parsed["cfg"]
        if c is None or c == self.ctl.cfg:
            return
        if self.ctl.aplicar_config(c):
            self._guardar_config(c)
            self.filas = 0
            self.log(f"CFG: aplicada y guardada ver={c.ver} intervalo={c.intervalo_s}s suelo on/off/sat={c.suelo_on}/{c.suelo_off}/{c.suelo_sat} "
                     f"temp_max={c.temp_max}C riego_max={c.riego_max_s}s espera={c.espera_s}s riego_auto={'ACTIVADO' if c.auto_riego else 'DESACTIVADO'}")

    def _atender_ordenes(self, parsed: dict) -> None:
        recibida = self.ahora()
        if parsed["ordenes"]:
            self.filas = 0
        for o in parsed["ordenes"]:
            o["recibida_ms"] = recibida
            r = self.ctl.atender_orden(o, self.ahora())
            if r["ignorada"]:
                self.log(f"ORDEN {o['id']}: repetida, se ignora")
            else:
                self.log(f"ORDEN {o['id']} -> {'ejecutada' if r['ejecutada'] else 'rechazada'} ({r['detalle']})")
            self.aplicar_bomba()

    # ---- consola
    def comando(self, c: str) -> None:
        c = c.strip().lower()[:1]
        o = {"id": "", "recibida_ms": self.ahora(), "vence_s": 5}
        if c == "r":
            r = self.ctl.atender_orden({**o, "tipo": "riego", "dur_s": 10}, self.ahora())
            self.log(f"CONSOLA regar 10 s -> {'ejecutada' if r['ejecutada'] else 'rechazada'} ({r['detalle']})")
            self.aplicar_bomba()
        elif c == "p":
            r = self.ctl.atender_orden({**o, "tipo": "parar"}, self.ahora())
            self.log(f"CONSOLA parar -> {r['detalle']}")
            self.aplicar_bomba()
        elif c == "s":
            self.fila_tabla(forzar_encabezado=True)
        elif c in ("?", "h"):
            self.log("Consola: r = regar 10 s | p = parar la bomba | s = estado")

    # ---- tabla
    def fila_tabla(self, forzar_encabezado: bool = False) -> None:
        if self.filas == 0 or forzar_encabezado:
            self.log("")
            self.log("  Tiempo  | Temp C | Aire % | Suelo | Banda    | Bomba  | Estado      | Espera | Auto | Red     | Fallas")
            self.log("----------+--------+--------+-------+----------+--------+-------------+--------+------+---------+-----------")
        self.filas = (self.filas + 1) % 15
        u, c = self.ultima, self.ctl
        up = self.ahora() // 1000
        temp = f"{u['temp']:.1f}" if u["temp_ok"] else "--"
        aire = f"{u['hum']:.1f}" if u["hum_ok"] else "--"
        suelo = str(u["suelo_raw"]) if u["suelo_ok"] else "--"
        banda = c.banda(u["suelo_raw"]) if u["suelo_ok"] else "-"
        bomba = f"ON {c.riego_s()}s" if c.bomba else "off"
        red = "-" if not self.red_activa else ("FALLO" if self.red_fallando else (f"ok #{self.red_ultima_ok}" if self.red_ultima_ok else "-"))
        fallas = "midiendo..." if not u["hay"] else (",".join(self._fallas()) or "ninguna")
        self.log(f" {up // 3600:02d}:{(up // 60) % 60:02d}:{up % 60:02d} | {temp:>6} | {aire:>6} | {suelo:>5} | {banda:<8} | {bomba:<6} | "
                 f"{c.estado():<11} | {c.espera_restante_s():>6} | {'SI' if c.cfg.auto_riego else 'NO':<4} | {red:<7} | {fallas}")

    # ---- bucle
    def paso(self) -> None:
        """Una vuelta del bucle (~50 ms). Separada para poder probarla."""
        now = self.ahora()
        self.ctl.tick(now)                                        # corte de seguridad: SIEMPRE lo primero
        self.aplicar_bomba()
        periodo = MUESTREO_RIEGO_S * 1000 if self.ctl.bomba else self.ctl.cfg.intervalo_s * 1000
        if not self.primera_muestra or now - self.t_ultima_muestra >= periodo or self.ctl.quiere_muestra_ya():
            self.hacer_ronda()
        self.gestionar_envio()
        if self.tabla_s > 0 and self.ahora() - self.t_tabla >= self.tabla_s * 1000:
            self.t_tabla = self.ahora()
            self.fila_tabla()

    def correr(self) -> None:
        self.log("=" * 45)
        self.log(f" Invernadero: nodo de riego  (firmware {FW_VERSION}, Raspberry Pi 5)")
        self.log("=" * 45)
        if not self.red_activa:
            self.log("RED: sin DEVICE_TOKEN -> modo local (el riego funciona; no se envia nada al dashboard)")
        else:
            self.log(f"RED: enviando a {self.url}")
        self.log("Consola: r = regar 10 s | p = parar | s = estado")
        self.iniciar_dht()
        if sys.stdin and sys.stdin.isatty():
            threading.Thread(target=self._leer_teclado, daemon=True).start()
        try:
            while self.corriendo:
                self.paso()
                time.sleep(0.05)
        finally:
            self.corriendo = False
            self.hw.cerrar()                                      # la bomba SIEMPRE queda apagada al salir
            self._guardar_marca_bomba(False)

    def _leer_teclado(self) -> None:
        try:
            for linea in sys.stdin:
                self.comando(linea)
        except Exception:                                         # noqa: BLE001
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Nodo del invernadero para Raspberry Pi 5")
    ap.add_argument("--simulado", action="store_true", help="sin hardware (valores de prueba)")
    args = ap.parse_args()
    hw = HardwareSimulado() if args.simulado else HardwareLgpio()
    nodo = Nodo(hw)

    def salir(*_):
        nodo.corriendo = False
    signal.signal(signal.SIGINT, salir)
    signal.signal(signal.SIGTERM, salir)
    nodo.correr()
    return 0


if __name__ == "__main__":
    sys.exit(main())
