#!/usr/bin/env python3
# Board #332's PKI (the N1 security review's third kit, rev-n1c): hand-built
# DER certificates that are malformed in ways a looser parser accepts and
# Node's OpenSSL refuses (or judges differently) — a CA's duplicate,
# malformed or unknown-element nameConstraints, key-usage / Netscape
# cert-type bit strings with unmasked unused bits, proxy certificates,
# undecodable name strings, times without their Z, malformed or duplicate
# CRL distribution points / IP blocks / leaf name constraints, a
# SmtpUTF8Mailbox under an email constraint, unnested RFC 3779 resources —
# beside the well-formed neighbours of each. Served by esrv.c (mbedTLS: it
# loads what OpenSSL will not) in tests/harness/wasmnative-host-rows.test.ts.
#
#   gen-malformed.py OUTDIR
#
# writes OUTDIR/<case>.pem (the chain the server sends, leaf first),
# OUTDIR/<case>.key, OUTDIR/extra.pem (the trusted roots) and
# OUTDIR/cases.json: [{name, host}]. Needs python3 with `cryptography`.
import datetime as dt, json, os, sys, subprocess
from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec, padding

D = sys.argv[1]
os.makedirs(D, exist_ok=True)
now = dt.datetime.now(dt.timezone.utc)

def L(n):
    if n < 0x80: return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b
def tlv(t, c): return bytes([t]) + L(len(c)) + c
def seq(*x): return tlv(0x30, b"".join(x))
def st(*x): return tlv(0x31, b"".join(x))
def oid(s):
    a = [int(v) for v in s.split(".")]
    out = bytes([a[0] * 40 + a[1]])
    for v in a[2:]:
        enc = [v & 0x7f]; v >>= 7
        while v: enc.append(0x80 | (v & 0x7f)); v >>= 7
        out += bytes(reversed(enc))
    return tlv(6, out)
def integer(n):
    b = n.to_bytes((n.bit_length() + 8) // 8 or 1, "big")
    return tlv(2, b)
def octs(b): return tlv(4, b)
def utc(t): return tlv(0x17, t.strftime("%y%m%d%H%M%SZ").encode())
TRUE = b"\x01\x01\xff"
CN, O = "2.5.4.3", "2.5.4.10"
def nm(*rdns):  # rdns: (oid, tag, bytes)
    return seq(*[st(seq(oid(o), tlv(t, v))) for (o, t, v) in rdns])
def cn(s): return nm((CN, 0x0c, s.encode()))
def ext(o, crit, val): return seq(oid(o), *( [TRUE] if crit else [] ), octs(val))
SHA256RSA = seq(oid("1.2.840.113549.1.1.11"), b"\x05\x00")
ECDSA256 = seq(oid("1.2.840.10045.4.3.2"))
def spki(k): return k.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
import hashlib
def skid_of(k): return hashlib.sha1(spki(k)).digest()
serial = [1000]
def cert(subject, subj_key, issuer, issuer_key, exts, nb=None, na=None, spki_der=None, akid=True, skid=True):
    serial[0] += 1
    e = list(exts)
    pub = spki_der or spki(subj_key)
    if skid: e.append(ext("2.5.29.14", False, octs(hashlib.sha1(pub).digest())))
    if akid and issuer_key is not None: e.append(ext("2.5.29.35", False, seq(tlv(0x80, skid_of(issuer_key)))))
    alg = SHA256RSA if isinstance(issuer_key, rsa.RSAPrivateKey) else ECDSA256
    tbs = seq(tlv(0xa0, integer(2)), integer(serial[0]), alg, issuer,
              seq(utc(nb or now - dt.timedelta(days=1)), utc(na or now + dt.timedelta(days=30))),
              subject, pub, tlv(0xa3, seq(*e)))
    if isinstance(issuer_key, rsa.RSAPrivateKey): sig = issuer_key.sign(tbs, padding.PKCS1v15(), hashes.SHA256())
    else: sig = issuer_key.sign(tbs, ec.ECDSA(hashes.SHA256()))
    return seq(tbs, alg, tlv(3, b"\x00" + sig))
def pem(der):
    import base64
    b = base64.encodebytes(der).decode().replace("\n", "")
    return ("-----BEGIN CERTIFICATE-----\n" + "\n".join(b[i:i+64] for i in range(0, len(b), 64)) + "\n-----END CERTIFICATE-----\n").encode()
def kpem(k): return k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
def key(bits=2048): return rsa.generate_private_key(public_exponent=65537, key_size=bits)

BC_CA = ext("2.5.29.19", True, seq(TRUE))
BC_LEAF = ext("2.5.29.19", True, seq())
KU_CA = ext("2.5.29.15", True, tlv(3, b"\x01\x06"))
KU_LEAF = ext("2.5.29.15", True, tlv(3, b"\x05\xa0"))
EKU_SRV = ext("2.5.29.37", False, seq(oid("1.3.6.1.5.5.7.3.1")))
def SAN(*gns): return ext("2.5.29.17", False, seq(*gns))
def DNS(s): return tlv(0x82, s.encode() if isinstance(s, str) else s)
H = "example.com"

rk = key(); RN = cn("Review Root C")
root = cert(RN, rk, RN, rk, [BC_CA, KU_CA])
open(f"{D}/root.pem", "wb").write(pem(root))
cases = []
port = [21000]
def emit(name, host, chain, k):
    port[0] += 1
    open(f"{D}/{name}.pem", "wb").write(b"".join(pem(c) for c in chain))
    open(f"{D}/{name}.key", "wb").write(kpem(k))
    cases.append({"name": name, "port": port[0], "host": host})
def leaf(name, exts=None, subject=None, host=H, issuer=(RN, rk), extra=(), k=None, **kw):
    k = k or key()
    exts = [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(host))] if exts is None else exts
    c = cert(subject or cn("leaf"), k, issuer[0], issuer[1], exts, **kw)
    emit(name, host, [c, *extra], k)
def inter(iname, exts, parent=(RN, rk), **kw):
    ik = key(); n = cn(iname)
    return n, ik, cert(n, ik, parent[0], parent[1], exts, **kw)

leaf("c_base")
# 1 proxyCertInfo (no SAN: EXFLAG_PROXY; with SAN: EXFLAG_INVALID)
PCI = ext("1.3.6.1.5.5.7.1.14", False, seq(seq(oid("1.3.6.1.5.5.7.21.1"))))
leaf("c_proxy_nosan", [BC_LEAF, KU_LEAF, EKU_SRV, PCI], subject=cn(H))
leaf("c_proxy_san", [BC_LEAF, KU_LEAF, EKU_SRV, PCI, SAN(DNS(H))])
# 2 key usage bits that OpenSSL masks by the unused-bit count
leaf("c_ku_leaf_masked", [BC_LEAF, ext("2.5.29.15", True, tlv(3, b"\x06\x20")), EKU_SRV, SAN(DNS(H))])
leaf("c_ku_leaf_unmasked", [BC_LEAF, ext("2.5.29.15", True, tlv(3, b"\x05\x20")), EKU_SRV, SAN(DNS(H))])
leaf("c_ku_leaf_empty", [BC_LEAF, ext("2.5.29.15", True, tlv(3, b"\x00")), EKU_SRV, SAN(DNS(H))])
n, ik, ic = inter("Inter KU masked", [BC_CA, ext("2.5.29.15", True, tlv(3, b"\x03\x86"))])
leaf("c_ku_ca_masked", issuer=(n, ik), extra=(ic,))
NS = "2.16.840.1.113730.1.1"
leaf("c_ns_leaf_masked", [BC_LEAF, KU_LEAF, EKU_SRV, ext(NS, False, tlv(3, b"\x07\x40")), SAN(DNS(H))])
# 3 names whose string values OpenSSL cannot convert
leaf("c_cn_bad_utf8", subject=nm((CN, 0x0c, b"\xff\xfe")))
leaf("c_cn_bmp_odd", subject=nm((CN, 0x1e, b"\x00a\x00")))
leaf("c_cn_univ_bad", subject=nm((CN, 0x1c, b"\x00\x11\x00\x00")))
leaf("c_o_bad_utf8", subject=nm((O, 0x0c, b"a\xc0\x80"), (CN, 0x0c, b"leaf")))
# 4 malformed extensions mbedTLS skips (non-critical)
leaf("c_leaf_bad_nc", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("2.5.29.30", False, seq(integer(1)))])
leaf("c_leaf_bad_crldp", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("2.5.29.31", False, seq(integer(1)))])
leaf("c_leaf_bad_ipaddr", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("1.3.6.1.5.5.7.1.7", False, seq(integer(1)))])
leaf("c_leaf_bad_aia", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("1.3.6.1.5.5.7.1.1", False, seq(integer(1)))])
leaf("c_leaf_bad_pc", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("2.5.29.36", False, seq(integer(1)))])
n, ik, ic = inter("Inter bad NC tag", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS(H))), tlv(0xa2, b"")))])
leaf("c_ca_nc_unknown_tag", issuer=(n, ik), extra=(ic,))
# 5 RFC 3779: leaf claims 10/8, parent has none
IPB = ext("1.3.6.1.5.5.7.1.7", True, seq(seq(octs(b"\x00\x01"), seq(tlv(3, b"\x00\x0a")))))
leaf("c_rfc3779_unnested", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), IPB])
# 6 SmtpUTF8Mailbox otherName vs an email constraint
NC_EMAIL = ext("2.5.29.30", True, seq(tlv(0xa0, seq(tlv(0x81, b".good.com")))))
n, ik, ic = inter("Inter NC email", [BC_CA, KU_CA, NC_EMAIL])
OTHER = tlv(0xa0, oid("1.3.6.1.5.5.7.8.9") + tlv(0xa0, tlv(0x0c, b"bad@evil.com")))
leaf("c_smtputf8_nc", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(OTHER)], subject=cn(H), issuer=(n, ik), extra=(ic,))
leaf("c_email_nc_ctrl", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(tlv(0x81, b"bad@evil.com"))], subject=cn(H), issuer=(n, ik), extra=(ic,))
# 7 explicit EC parameters (leaf, under R)
subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-param_enc", "explicit", "-genkey", "-noout", "-out", f"{D}/ecx.key"], check=True)
ekd = subprocess.run(["openssl", "pkey", "-in", f"{D}/ecx.key", "-pubout", "-outform", "DER"], check=True, capture_output=True).stdout
c = cert(cn("leaf"), None, RN, rk, [BC_LEAF, ext("2.5.29.15", True, tlv(3, b"\x07\x80")), EKU_SRV, SAN(DNS(H))], spki_der=ekd)
port[0] += 1
open(f"{D}/c_ec_explicit.pem", "wb").write(pem(c))
open(f"{D}/c_ec_explicit.key", "wb").write(open(f"{D}/ecx.key", "rb").read())
cases.append({"name": "c_ec_explicit", "port": port[0], "host": H})
# 8 pathlen on a non-CA leaf
leaf("c_leaf_pathlen", [ext("2.5.29.19", True, seq(integer(0))), KU_LEAF, EKU_SRV, SAN(DNS(H))])
# 9 critical SKID / AKID
leaf("c_crit_skid", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("2.5.29.14", True, octs(b"abcd"))], skid=False)
# 10 root carries name constraints (trust anchor constraints)
k2 = key(); RN2 = cn("Review Root NC")
NC_ALLOWED = ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS("allowed.com")))))
root2 = cert(RN2, k2, RN2, k2, [BC_CA, KU_CA, NC_ALLOWED])
open(f"{D}/root2.pem", "wb").write(pem(root2))
leaf("c_root_nc_viol", issuer=(RN2, k2))
leaf("c_root_nc_ok", host="a.allowed.com", issuer=(RN2, k2))
# 11 mimic: untrusted cert with root's name and SKID, other key
mk = key()
mimic = cert(RN, mk, RN, mk, [BC_CA, KU_CA], skid=False, akid=False)
# give the mimic root's SKID by hand
serial[0] += 1
e = [BC_CA, KU_CA, ext("2.5.29.14", False, octs(skid_of(rk)))]
tbs = seq(tlv(0xa0, integer(2)), integer(serial[0]), SHA256RSA, RN, seq(utc(now - dt.timedelta(days=1)), utc(now + dt.timedelta(days=30))), RN, spki(mk), tlv(0xa3, seq(*e)))
mimic = seq(tbs, SHA256RSA, tlv(3, b"\x00" + mk.sign(tbs, padding.PKCS1v15(), hashes.SHA256())))
lk = key()
lc = cert(cn("leaf"), lk, RN, mk, [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H))], akid=False)
# leaf's AKID = root's SKID, signed by the mimic's key
serial[0] += 1
e = [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("2.5.29.35", False, seq(tlv(0x80, skid_of(rk))))]
tbs = seq(tlv(0xa0, integer(2)), integer(serial[0]), SHA256RSA, RN, seq(utc(now - dt.timedelta(days=1)), utc(now + dt.timedelta(days=30))), cn("leaf"), spki(lk), tlv(0xa3, seq(*e)))
lc = seq(tbs, SHA256RSA, tlv(3, b"\x00" + mk.sign(tbs, padding.PKCS1v15(), hashes.SHA256())))
emit("c_mimic_skid", H, [lc, mimic], lk)
# same but no AKID on leaf
lc2 = cert(cn("leaf"), lk, RN, mk, [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H))], akid=False)
emit("c_mimic_noakid", H, [lc2, mimic], lk)
# 12 cross-signed intermediate, two orderings
uk = key(); UN = cn("Untrusted Root C")
uroot = cert(UN, uk, UN, uk, [BC_CA, KU_CA])
xk = key(); XN = cn("Inter X")
x_by_u = cert(XN, xk, UN, uk, [BC_CA, KU_CA])
x_by_r = cert(XN, xk, RN, rk, [BC_CA, KU_CA])
lk = key(); lx = cert(cn("leaf"), lk, XN, xk, [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H))])
emit("c_cross_u_first", H, [lx, x_by_u, x_by_r], lk)
emit("c_cross_r_first", H, [lx, x_by_r, x_by_u], lk)
emit("c_cross_u_root", H, [lx, x_by_u, uroot, x_by_r], lk)
# 13 inter with explicit-params EC key? (CA key) skip; inter with sha1 sig is in the old kit
# 14 leaf with two SANs, one DNS whose name has a trailing dot, NC permitted allowed.com
n, ik, ic = inter("Inter NC allowed", [BC_CA, KU_CA, NC_ALLOWED])
leaf("c_nc_cn_trail_dot", [BC_LEAF, KU_LEAF, EKU_SRV], subject=cn(H + "."), issuer=(n, ik), extra=(ic,))
leaf("c_nc_uri_only_san", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(tlv(0x86, b"https://allowed.com/"))], subject=cn(H), issuer=(n, ik), extra=(ic,))
leaf("c_nc_ip_v6_len", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS("a.allowed.com"), tlv(0x87, b"\x7f\x00\x00\x01"))], host="a.allowed.com", issuer=(n, ik), extra=(ic,))
n6, ik6, ic6 = inter("Inter NC ip6", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(tlv(0x87, b"\x00" * 32)))))])
leaf("c_nc_ip6_base_v4", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H), tlv(0x87, b"\x7f\x00\x00\x01"))], issuer=(n6, ik6), extra=(ic6,))
n5, ik5, ic5 = inter("Inter NC ip5", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(tlv(0x87, b"\x7f\x00\x00\x01\xff")))))])
leaf("c_nc_ip_base_len5", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H), tlv(0x87, b"\x7f\x00\x00\x01"))], issuer=(n5, ik5), extra=(ic5,))
leaf("c_nc_ip_base_len5_noip", issuer=(n5, ik5), extra=(ic5,))
# empty permitted subtree list (permitted [0] present but empty)
ne, ike, ice = inter("Inter NC empty", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, b"")))])
leaf("c_nc_empty_permitted", issuer=(ne, ike), extra=(ice,))
# DNS constraint "example.com" (no dot) vs a.example.com, and base with empty string
nd, ikd, icd = inter("Inter NC exdot", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS("example.com")))))])
leaf("c_nc_nodot_sub", host="a.example.com", issuer=(nd, ikd), extra=(icd,))
leaf("c_nc_nodot_suffix", host="badexample.com", issuer=(nd, ikd), extra=(icd,))
nz, ikz, icz = inter("Inter NC emptydns", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa1, seq(DNS("")))))])
leaf("c_nc_excl_empty_dns", issuer=(nz, ikz), extra=(icz,))
# minimum/maximum present
nm_, ikm, icm = inter("Inter NC max", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS(H), tlv(0x81, b"\x02")))))])
leaf("c_nc_maximum", issuer=(nm_, ikm), extra=(icm,))
# EKU anyEKU-only leaf; EKU on leaf absent + CA with clientAuth
leaf("c_eku_any_leaf", [BC_LEAF, KU_LEAF, ext("2.5.29.37", False, seq(oid("2.5.29.37.0"))), SAN(DNS(H))])
# leaf without SKID/AKID, with duplicate SAN extension
leaf("c_dup_san", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), SAN(DNS("x.com"))])
# leaf with critical unknown ext in TRUSTED root (root3)
k3 = key(); RN3 = cn("Review Root Crit")
root3 = cert(RN3, k3, RN3, k3, [BC_CA, KU_CA, ext("1.3.6.1.4.1.99999.7", True, b"\x05\x00")])
open(f"{D}/root3.pem", "wb").write(pem(root3))
leaf("c_root_unk_crit", issuer=(RN3, k3))
# leaf with an unknown critical extension inside a cert mbedTLS also must keep
leaf("c_crit_policy_unknown", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), ext("2.5.29.32", True, seq(seq(oid("1.2.3.4"))))])
# BC with explicit cA FALSE + pathlen on an intermediate (pathlen w/o CA)
n, ik, ic = inter("Inter v1like", [ext("2.5.29.19", True, seq(b"\x01\x01\x00", integer(3))), KU_CA])
leaf("c_inter_ca_false_pathlen", issuer=(n, ik), extra=(ic,))
# a 1024-bit intermediate
ik = key(1024); n = cn("Inter 1024")
ic = cert(n, ik, RN, rk, [BC_CA, KU_CA])
leaf("c_inter_rsa1024", issuer=(n, ik), extra=(ic,))
# leaf signed by sha1 (leaf's own signature)

# 15 times without the trailing Z (mbedTLS takes YYMMDDHHMMSS)
def cert_t(subject, subj_key, issuer, issuer_key, exts, nbraw, naraw):
    serial[0] += 1
    e = list(exts) + [ext("2.5.29.14", False, octs(skid_of(subj_key))), ext("2.5.29.35", False, seq(tlv(0x80, skid_of(issuer_key))))]
    tbs = seq(tlv(0xa0, integer(2)), integer(serial[0]), SHA256RSA, issuer, seq(nbraw, naraw), subject, spki(subj_key), tlv(0xa3, seq(*e)))
    return seq(tbs, SHA256RSA, tlv(3, b"\x00" + issuer_key.sign(tbs, padding.PKCS1v15(), hashes.SHA256())))
lk = key()
nbz = tlv(0x17, (now - dt.timedelta(days=1)).strftime("%y%m%d%H%M%S").encode())
naz = tlv(0x17, (now + dt.timedelta(days=30)).strftime("%y%m%d%H%M%S").encode())
emit("c_time_noz", H, [cert_t(cn("leaf"), lk, RN, rk, [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H))], utc(now - dt.timedelta(days=1)), naz)], lk)
emit("c_time_noz_nb", H, [cert_t(cn("leaf"), lk, RN, rk, [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H))], nbz, utc(now + dt.timedelta(days=30)))], lk)
# 16 duplicate name constraints on the CA (OpenSSL: EXFLAG_INVALID); the second one permissive
n, ik, ic = inter("Inter dup NC", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS("allowed.com"))))), ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS(H)))))])
leaf("c_ca_dup_nc", issuer=(n, ik), extra=(ic,))
# 17 duplicate CRLDP on the leaf (well-formed each)
CRLDP = ext("2.5.29.31", False, seq(seq(tlv(0xa0, tlv(0xa0, tlv(0x86, b"http://x/crl"))))))
leaf("c_leaf_crldp_ok", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), CRLDP])
leaf("c_leaf_dup_crldp", [BC_LEAF, KU_LEAF, EKU_SRV, SAN(DNS(H)), CRLDP, CRLDP])
# 18 a CA whose NC is well-formed but carries a trailing element after the subtrees
n, ik, ic = inter("Inter NC trailing", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(DNS("allowed.com"))), integer(1)))])
leaf("c_ca_nc_trailing", host="a.allowed.com", issuer=(n, ik), extra=(ic,))
# 19 a CA whose NC base is an IA5 string with a bad inner encoding: a SAN dNSName the CA NC must see,
# with an x400Address (unsupported) constraint present
n, ik, ic = inter("Inter NC x400", [BC_CA, KU_CA, ext("2.5.29.30", True, seq(tlv(0xa0, seq(tlv(0xa3, seq())))))])
leaf("c_ca_nc_x400_no_x400_name", issuer=(n, ik), extra=(ic,))
open(f"{D}/extra.pem", "wb").write(pem(root) + pem(root2) + pem(root3))
json.dump(cases, open(f"{D}/cases.json", "w"), indent=0)
print(len(cases), "cases")
