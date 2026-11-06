#!/usr/bin/env node
/* Pega las claves RSA-2048 dentro de espnow_cifrado.ino (sin instalar nada: solo Node.js 16+).
 *
 *   node pegar-claves.mjs espnow_cifrado.ino --privada privada.pem --socio publica-del-otro-grupo.pem
 *
 *   --privada  SU clave privada (PEM, PKCS#1 o PKCS#8). Se pegan sus componentes CRT (p, q, dp, dq, iq). La publica propia no hace falta.
 *   --socio    la clave PUBLICA del otro grupo (PEM, o tambien un PEM privado: solo se toma la parte publica).
 *   Puede pasar solo una de las dos. Reemplaza lo que haya entre los marcadores RSA_PRIVADA_* / RSA_SOCIO_PUBLICA_*.
 *   Genere las claves con:  openssl genrsa -out privada.pem 2048 && openssl rsa -in privada.pem -pubout -out publica.pem
 *   El archivo .ino resultante contiene su clave PRIVADA: no lo comparta.
 */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const sketch = args.find((a) => !a.startsWith('--') && /\.ino$/i.test(a));
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const privada = opt('--privada');
const socio = opt('--socio');
if (!sketch || (!privada && !socio)) {
  console.error('Uso: node pegar-claves.mjs espnow_cifrado.ino --privada privada.pem --socio publica-del-otro-grupo.pem');
  process.exit(1);
}

const b64u = (s) => Buffer.from(s, 'base64url');
const bloque = (nombre, bytes) => {
  const filas = [];
  for (let i = 0; i < bytes.length; i += 16) filas.push('  ' + [...bytes.subarray(i, i + 16)].map((b) => '0x' + b.toString(16).padStart(2, '0')).join(', '));
  return `static const uint8_t ${nombre}[${bytes.length}] = {\n${filas.join(',\n')}\n};`;
};
const huella = (pub) => createHash('sha256').update(pub.export({ type: 'spki', format: 'der' })).digest('hex').match(/.{2}/g).join(':');

function cargarPublica(ruta) {
  const pem = readFileSync(ruta, 'utf8');
  let k;
  try { k = createPublicKey(pem); } catch (e) { throw new Error(`${ruta}: no es una clave RSA en PEM (${e.message})`); }
  if (k.asymmetricKeyType !== 'rsa') throw new Error(`${ruta}: no es una clave RSA`);
  const j = k.export({ format: 'jwk' });
  const n = b64u(j.n);
  if (n.length !== 256) throw new Error(`${ruta}: la clave es de ${n.length * 8} bits; este sketch necesita RSA-2048`);
  return { n, e: b64u(j.e), pub: k };
}

let texto = readFileSync(sketch, 'utf8');
const crlf = texto.includes('\r\n');
texto = texto.replace(/\r\n/g, '\n');

function reemplazar(marca, contenido, nota) {
  const re = new RegExp(`(// ${marca}_INICIO)[^\\n]*\\n[\\s\\S]*?(// ${marca}_FIN)`);
  if (!re.test(texto)) throw new Error(`No encuentro los marcadores ${marca}_INICIO / ${marca}_FIN en ${sketch}`);
  texto = texto.replace(re, (_, a, b) => `${a}  (${nota})\n${contenido}\n${b}`);
}

try {
  if (privada) {
    const k = createPrivateKey(readFileSync(privada, 'utf8'));
    if (k.asymmetricKeyType !== 'rsa') throw new Error(`${privada}: no es una clave RSA`);
    const j = k.export({ format: 'jwk' });
    const n = b64u(j.n);
    if (n.length !== 256) throw new Error(`${privada}: la clave es de ${n.length * 8} bits; este sketch necesita RSA-2048`);
    const pub = createPublicKey(k);
    reemplazar('RSA_PRIVADA', [
      `static const uint32_t RSA_PRIV_BITS = ${n.length * 8};`,
      bloque('RSA_PRIV_P', b64u(j.p)), bloque('RSA_PRIV_Q', b64u(j.q)),
      bloque('RSA_PRIV_DP', b64u(j.dp)), bloque('RSA_PRIV_DQ', b64u(j.dq)), bloque('RSA_PRIV_IQ', b64u(j.qi)),
    ].join('\n'), 'clave PRIVADA propia: NO compartir este archivo');
    console.log(`Privada propia pegada. Huella de SU clave publica (dela al otro grupo para que la compare):\n  ${huella(pub)}`);
  }
  if (socio) {
    const s = cargarPublica(socio);
    reemplazar('RSA_SOCIO_PUBLICA', [bloque('RSA_SOCIO_N', s.n), bloque('RSA_SOCIO_E', s.e)].join('\n'), 'clave publica del otro grupo');
    console.log(`Publica del otro grupo pegada. Huella (comparela con la que le diga el otro grupo):\n  ${huella(s.pub)}`);
  }
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}

writeFileSync(sketch, crlf ? texto.replace(/\n/g, '\r\n') : texto);
console.log(`Listo: ${sketch} actualizado.` + (privada ? ' Ahora contiene su clave privada: no lo comparta.' : ''));
