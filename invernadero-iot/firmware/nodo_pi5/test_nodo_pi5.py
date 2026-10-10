"""Pruebas de nodo_pi5.py SIN hardware (python3 -m unittest -v test_nodo_pi5)."""
import dataclasses
import json
import os
import tempfile
import unittest

import nodo_pi5 as n
from nodo_pi5 import Config, Controlador, HardwareSimulado, Lectura, Nodo, Plan

SECO = Lectura(True, 900, True, 25.0)
OPTIMO = Lectura(True, 450, True, 25.0)
SATURADO = Lectura(True, 100, True, 25.0)
SIN_SENSOR = Lectura(False, 0, True, 25.0)


def nuevo(cfg=None):
    c = Controlador(0)
    if cfg:
        assert c.aplicar_config(cfg)
    return c


class TestConfig(unittest.TestCase):
    def test_por_defecto_es_valida(self):
        self.assertTrue(n.config_valida(Config()))

    def test_reglas(self):
        for cambio in ({"suelo_sat": 0}, {"suelo_on": 1024}, {"suelo_off": 700}, {"suelo_sat": 500}, {"temp_max": 29.9},
                       {"temp_max": float("nan")}, {"riego_max_s": 4}, {"riego_max_s": 121}, {"espera_s": 59}, {"intervalo_s": 4}):
            self.assertFalse(n.config_valida(dataclasses.replace(Config(), **cambio)), cambio)


class TestRiegoAutomatico(unittest.TestCase):
    def test_inicia_corta_por_tiempo_y_espera(self):
        c = nuevo()
        c.nueva_lectura(SECO, 1000)
        self.assertTrue(c.bomba)
        self.assertEqual(c.eventos[-1]["motivo"], "auto")
        c.tick(1000 + 29_000)
        self.assertTrue(c.bomba)
        c.tick(1000 + 30_000)                                     # corte duro a los 30 s
        self.assertFalse(c.bomba)
        self.assertEqual((c.eventos[-1]["motivo"], c.eventos[-1]["dur_s"]), ("tiempo_max", 30))
        c.nueva_lectura(SECO, 40_000)                             # en espera: no riega
        self.assertFalse(c.bomba)
        self.assertEqual(c.estado(), "espera")
        c.tick(31_000 + 300_000)                                  # termina la espera con demanda de riego: mide YA
        self.assertTrue(c.quiere_muestra_ya())
        c.nueva_lectura(SECO, 331_000)
        self.assertTrue(c.bomba)

    def test_corta_al_llegar_a_la_humedad_objetivo(self):
        c = nuevo()
        c.nueva_lectura(SECO, 0)
        c.nueva_lectura(Lectura(True, 500, True, 25.0), 5000)     # <= suelo_off
        self.assertFalse(c.bomba)
        self.assertEqual(c.eventos[-1]["motivo"], "objetivo")

    def test_no_riega_si_esta_humedo_o_saturado(self):
        for l in (OPTIMO, SATURADO):
            c = nuevo()
            c.nueva_lectura(l, 0)
            self.assertFalse(c.bomba)

    def test_desactivado_desde_el_dashboard_no_inicia(self):
        c = nuevo(dataclasses.replace(Config(), auto_riego=False))
        c.nueva_lectura(SECO, 0)
        self.assertFalse(c.bomba)
        self.assertEqual(c.estado(), "idle")

    def test_calor_y_sensores_bloquean(self):
        c = nuevo()
        c.nueva_lectura(Lectura(True, 900, True, 41.0), 0)
        self.assertFalse(c.bomba)
        self.assertEqual(c.estado(), "bloq_temp")
        c.nueva_lectura(Lectura(True, 900, False, 0.0), 1000)     # sin temperatura valida
        self.assertFalse(c.bomba)
        c.nueva_lectura(SIN_SENSOR, 2000)                         # sin suelo valido
        self.assertFalse(c.bomba)
        self.assertEqual(c.estado(), "bloq_sensor")

    def test_falla_del_sensor_corta_un_riego_automatico(self):
        c = nuevo()
        c.nueva_lectura(SECO, 0)
        c.nueva_lectura(SIN_SENSOR, 5000)
        self.assertFalse(c.bomba)
        self.assertEqual(c.eventos[-1]["motivo"], "seguridad")

    def test_arranque_tras_corte_con_bomba_encendida_parte_en_espera(self):
        c = Controlador(0, riego_interrumpido=True)
        self.assertEqual(c.eventos[0]["motivo"], "seguridad")
        c.nueva_lectura(SECO, 1000)
        self.assertFalse(c.bomba)                                 # espera activa


class TestOrdenes(unittest.TestCase):
    def orden(self, **kw):
        return {"id": "a1", "tipo": "riego", "dur_s": 10, "vence_s": 120, "recibida_ms": 0, **kw}

    def test_riego_manual_y_corte_por_orden(self):
        c = nuevo()
        c.nueva_lectura(OPTIMO, 0)
        r = c.atender_orden(self.orden(), 100)
        self.assertTrue(r["ejecutada"], r)
        self.assertTrue(c.bomba)
        c.tick(100 + 9_999)
        self.assertTrue(c.bomba)
        c.tick(100 + 10_000)
        self.assertFalse(c.bomba)
        self.assertEqual(c.eventos[-1]["motivo"], "orden")
        self.assertEqual(c.acks[-1]["ejecutada"], True)

    def test_rechazos(self):
        c = nuevo()
        c.nueva_lectura(SATURADO, 0)
        self.assertEqual(c.atender_orden(self.orden(id="x1"), 10)["detalle"], "suelo saturado")
        c2 = nuevo()
        c2.nueva_lectura(OPTIMO, 0)
        self.assertEqual(c2.atender_orden(self.orden(id="x2", dur_s=4), 10)["detalle"][:9], "duracion ")
        self.assertEqual(c2.atender_orden(self.orden(id="x3", vence_s=1), 5000)["detalle"], "vencida")
        c2.atender_orden(self.orden(id="x4"), 10)
        self.assertEqual(c2.atender_orden(self.orden(id="x5"), 20)["detalle"], "ya esta regando")
        c2.tick(10_010)                                           # termino -> espera entre riegos
        self.assertTrue(c2.atender_orden(self.orden(id="x6"), 10_020)["detalle"].startswith("en espera entre riegos"))

    def test_con_sensor_en_falla_el_operador_decide(self):
        c = nuevo()
        c.nueva_lectura(SIN_SENSOR, 0)
        r = c.atender_orden(self.orden(), 10)
        self.assertTrue(r["ejecutada"])
        self.assertIn("suelo sin lectura", r["detalle"])
        c.nueva_lectura(SIN_SENSOR, 5000)                         # el riego manual sigue
        self.assertTrue(c.bomba)

    def test_se_acorta_al_maximo_y_se_ignoran_repetidas(self):
        c = nuevo(dataclasses.replace(Config(), riego_max_s=20))
        c.nueva_lectura(OPTIMO, 0)
        r = c.atender_orden(self.orden(dur_s=60), 10)
        self.assertIn("acortada", r["detalle"])
        self.assertTrue(c.atender_orden(self.orden(), 20)["ignorada"])

    def test_parar_siempre_funciona(self):
        c = nuevo()
        c.nueva_lectura(OPTIMO, 0)
        c.atender_orden(self.orden(), 10)
        r = c.atender_orden({"id": "p1", "tipo": "parar", "vence_s": 0, "recibida_ms": 0}, 99_999)   # vencida: igual se ejecuta
        self.assertTrue(r["ejecutada"])
        self.assertFalse(c.bomba)

    def test_tipo_desconocido(self):
        c = nuevo()
        self.assertFalse(c.atender_orden({"id": "q", "tipo": "desconocido"}, 0)["ejecutada"])


class TestEnvio(unittest.TestCase):
    def test_exito_reintento_y_descarte(self):
        p = Plan(0)
        self.assertEqual(p.decidir(0, True, False), Plan.ENVIAR_NUEVA)
        p.entregada(0)
        self.assertEqual(p.respuesta(1, 200, True, 0, 300_000), Plan.EXITO)
        self.assertEqual(p.decidir(1000, True, False), Plan.NADA)
        self.assertEqual(p.decidir(301_000, True, False), Plan.ENVIAR_NUEVA)
        p.entregada(301_000)
        self.assertEqual(p.respuesta(302_000, 500, False, 0, 300_000), Plan.REINTENTAR)
        p.entregada(306_000)
        self.assertEqual(p.respuesta(307_000, -1, False, 0, 300_000), Plan.REINTENTAR)
        p.entregada(314_000)
        self.assertEqual(p.respuesta(315_000, -1, False, 0, 300_000), Plan.DESCARTAR)

    def test_codigos(self):
        p = Plan(0)
        p.entregada(0)
        self.assertEqual(p.respuesta(0, 401, False, 0, 1000), Plan.DESCARTAR)
        self.assertEqual(p.espera_ms, n.ESPERA_401_MS)
        for i in range(3):
            p.entregada(10_000 * i)
            r = p.respuesta(10_000 * i, 400, False, 0, 1000)
        self.assertEqual(r, Plan.DESCARTAR_Y_LIMPIAR)

    def test_novedad_sale_sin_esperar_el_periodo(self):
        p = Plan(0)
        p.entregada(0)
        p.respuesta(1, 200, True, 0, 300_000)
        self.assertEqual(p.decidir(3000, True, True), Plan.ENVIAR_NUEVA)
        self.assertEqual(p.decidir(1500, True, True), Plan.NADA)   # separacion minima de 2 s


class TestRespuesta(unittest.TestCase):
    def test_cfg_y_ordenes(self):
        txt = json.dumps({"ok": True, "t": "x", "cfg": {"ver": 7, "intervalo_s": 10, "suelo_on": 700, "suelo_off": 500, "suelo_sat": 1,
                                                        "temp_max": 40, "riego_max_s": 30, "espera_s": 300, "auto": 0},
                          "ordenes": [{"id": "0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11", "tipo": "riego", "dur_s": 20, "vence_s": 240},
                                      {"id": "mala id!", "tipo": "riego"}, {"id": "p1", "tipo": "parar", "vence_s": 5}]})
        r = n.parsear_respuesta(txt, Config())
        self.assertTrue(r["ok"])
        self.assertEqual((r["cfg"].ver, r["cfg"].suelo_sat, r["cfg"].auto_riego, r["cfg"].intervalo_s), (7, 1, False, 10))
        self.assertEqual([o["tipo"] for o in r["ordenes"]], ["riego", "parar"])   # la de id invalido se ignora

    def test_invalida_o_ilegible(self):
        self.assertIsNone(n.parsear_respuesta("no es json", Config()))
        self.assertIsNone(n.parsear_respuesta("[1]", Config()))
        r = n.parsear_respuesta(json.dumps({"ok": True, "cfg": {"suelo_sat": 900}}), Config())   # sat > off: se ignora completa
        self.assertTrue(r["cfg_invalida"])
        self.assertIsNone(r["cfg"])
        self.assertFalse(n.parsear_respuesta(json.dumps({"ok": False}), Config())["ok"])


class RelojFalso:
    def __init__(self):
        self.ms = 0


def crear_nodo(hw, enviar, tmp):
    reloj = RelojFalso()
    nodo = Nodo(hw, url="http://x", token="tok", enviar=enviar, estado_archivo=os.path.join(tmp, "cfg.json"),
                bomba_archivo=os.path.join(tmp, "bomba"), tabla_s=10, salida=lambda m: None)
    nodo.ahora = lambda: reloj.ms
    nodo.dht_cache = (True, 24.0, 60.0, 1e18)                     # lectura del DHT22 siempre vigente
    nodo.t_ultima_muestra = 0
    return nodo, reloj


def avanzar(nodo, reloj, ms, paso=50):
    import time
    fin = reloj.ms + ms
    while reloj.ms < fin:
        reloj.ms += paso
        nodo.paso()
        time.sleep(0.0005)                                        # deja correr los hilos de red


class TestNodoIntegrado(unittest.TestCase):
    def test_orden_del_dashboard_enciende_la_bomba_y_se_acusa(self):
        tramas = []
        orden_id = "0b6c1a52-7c1e-4f0e-9a0c-2f3e7a9d1c11"
        pendiente = {"entregar": True}

        def servidor(url, token, cuerpo):
            t = json.loads(cuerpo)
            tramas.append(t)
            cfg = {"ver": 4, "intervalo_s": 10, "suelo_on": 700, "suelo_off": 500, "suelo_sat": 1, "temp_max": 40,
                   "riego_max_s": 30, "espera_s": 300, "auto": 0}
            ords = []
            if pendiente["entregar"] and len(tramas) >= 2:
                pendiente["entregar"] = False
                ords = [{"id": orden_id, "tipo": "riego", "dur_s": 10, "vence_s": 600}]
            return 200, json.dumps({"ok": True, "t": "2026-10-07T00:00:00Z", "cfg": cfg, "ordenes": ords}), 0

        with tempfile.TemporaryDirectory() as tmp:
            hw = HardwareSimulado(suelo_raw=450)
            nodo, reloj = crear_nodo(hw, servidor, tmp)
            # la 1.a respuesta trae intervalo_s = 10, pero el plan de esa trama ya usaba 300 s (igual que el firmware): la 2.a sale a los ~300 s
            avanzar(nodo, reloj, 400_000)
            self.assertGreaterEqual(len(tramas), 2)
            self.assertEqual(tramas[0]["suelo_raw"], 450)
            self.assertEqual(tramas[0]["fw"], n.FW_VERSION)
            self.assertFalse(nodo.ctl.cfg.auto_riego)             # llego cfg.auto = 0
            self.assertEqual(nodo.ctl.cfg.suelo_sat, 1)
            self.assertTrue(os.path.exists(os.path.join(tmp, "cfg.json")))   # la config se guardo
            self.assertEqual(hw.historial_rele[:2], [True, False])  # el rele se encendio y se apago
            self.assertFalse(hw.rele_on)
            ack = [a for t in tramas for a in t.get("acks", [])]
            self.assertEqual([(a["id"], a["estado"]) for a in ack], [(orden_id, "ejecutada")])
            evs = [e for t in tramas for e in t.get("ev", [])]
            self.assertEqual([(e["t"], e["why"], e.get("cmd")) for e in evs], [("pump_on", "manual", orden_id), ("pump_off", "orden", orden_id)])
            self.assertEqual([t["seq"] for t in tramas], list(range(1, len(tramas) + 1)))   # seq consecutivo
            self.assertEqual(len({t["boot"] for t in tramas}), 1)
            # los eventos y acuses se envian una sola vez
            self.assertEqual(len(evs), 2)

    def test_sensor_de_suelo_en_falla_se_informa(self):
        tramas = []

        def servidor(url, token, cuerpo):
            tramas.append(json.loads(cuerpo))
            return 200, json.dumps({"ok": True, "cfg": {}, "ordenes": []}), 0

        with tempfile.TemporaryDirectory() as tmp:
            nodo, reloj = crear_nodo(HardwareSimulado(suelo_ok=False), servidor, tmp)
            avanzar(nodo, reloj, 20_000)
            t = tramas[0]
            self.assertIsNone(t["suelo_raw"])
            self.assertEqual(t["est"], "bloq_sensor")
            self.assertIn("suelo", t["fallas"])
            self.assertEqual(t["bomba"], 0)

    def test_sin_token_funciona_solo_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            hw = HardwareSimulado(suelo_raw=900)
            nodo, reloj = crear_nodo(hw, lambda *a: (_ for _ in ()).throw(AssertionError("no debe enviar")), tmp)
            nodo.red_activa = False
            avanzar(nodo, reloj, 40_000)
            self.assertEqual(hw.historial_rele[:2], [True, False])  # riego automatico local: seco -> riega 30 s -> corta
            self.assertIn(nodo.ctl.eventos[-1]["motivo"], ("tiempo_max",))

    def test_servidor_caido_reintenta_la_misma_trama(self):
        intentos = []

        def servidor(url, token, cuerpo):
            intentos.append(json.loads(cuerpo)["seq"])
            return (-1, "", 0) if len(intentos) < 3 else (200, json.dumps({"ok": True, "cfg": {}, "ordenes": []}), 0)

        with tempfile.TemporaryDirectory() as tmp:
            nodo, reloj = crear_nodo(HardwareSimulado(suelo_raw=450), servidor, tmp)
            avanzar(nodo, reloj, 30_000)
            self.assertEqual(intentos[:3], [1, 1, 1])             # mismo seq en cada reintento

    def test_marca_de_bomba_encendida_obliga_a_esperar_al_reiniciar(self):
        with tempfile.TemporaryDirectory() as tmp:
            with open(os.path.join(tmp, "bomba"), "w") as f:
                f.write("1")
            nodo, reloj = crear_nodo(HardwareSimulado(suelo_raw=900), lambda *a: (200, "{}", 0), tmp)
            nodo.red_activa = False
            avanzar(nodo, reloj, 5_000)
            self.assertFalse(nodo.ctl.bomba)                      # no repite el riego de inmediato


if __name__ == "__main__":
    unittest.main(verbosity=2)
