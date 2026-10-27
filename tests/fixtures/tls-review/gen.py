#!/usr/bin/env python3
# The security re-review's PKI (native-runner N1): one certificate chain per
# case, each served by its own TLS server in
# tests/harness/wasmnative-host-rows.test.ts, which compares the wasm-native
# lane's fetch and tls.connect verdicts with Node's.
#
#   gen.py OUTDIR
#
# writes OUTDIR/root.pem (the trusted root R), OUTDIR/extra.pem (R plus a
# trusted intermediate TI whose root is not trusted: partial chains),
# OUTDIR/<case>.pem (the chain the server sends, leaf first) and
# OUTDIR/<case>.key, and OUTDIR/cases.json: [{name, host}] — the host the
# client asks for. Needs python3 with `cryptography`.
#
# The host-name and chain cases are the re-review kit's (gen.py of the
# review); the m_/v_ cases add the name-constraint types, the
# last-error-wins combinations and the untrusted-chain verdicts.
import datetime as dt, ipaddress, json, os, sys
from cryptography import x509
from cryptography.x509.name import _ASN1Type
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID, ObjectIdentifier
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec

D = sys.argv[1]
os.makedirs(D, exist_ok=True)
now = dt.datetime.now(dt.timezone.utc)
POOL = [rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(8)]
_ki = [0]
def key(bits=2048):
    if bits != 2048:
        return rsa.generate_private_key(public_exponent=65537, key_size=bits)
    _ki[0] += 1
    return POOL[_ki[0] % len(POOL)]
def name(*cns):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, c) for c in cns])
def pem(c): return c.public_bytes(serialization.Encoding.PEM)
def kpem(k): return k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())

def build(subject, pub, issuer_name, issuer_key, exts, nb=None, na=None, h=hashes.SHA256()):
    b = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer_name)
         .public_key(pub).serial_number(x509.random_serial_number())
         .not_valid_before(nb or now - dt.timedelta(days=1))
         .not_valid_after(na or now + dt.timedelta(days=30)))
    for e, crit in exts: b = b.add_extension(e, critical=crit)
    return b.sign(issuer_key, h)

def ca_exts(path=None, ku=True, ca=True, bc=True, eku=None, nc=None, nc_crit=True):
    ex = []
    if bc: ex.append((x509.BasicConstraints(ca=ca, path_length=path), True))
    if ku: ex.append((x509.KeyUsage(True, False, False, False, False, True, True, False, False), True))
    if eku: ex.append((x509.ExtendedKeyUsage(eku), False))
    if nc: ex.append((nc, nc_crit))
    return ex

# the CAs: distinct keys
rk = rsa.generate_private_key(public_exponent=65537, key_size=2048); rn = name("Review Root R")
root = build(rn, rk.public_key(), rn, rk, ca_exts())
uk = rsa.generate_private_key(public_exponent=65537, key_size=2048); un = name("Untrusted Root U")
uroot = build(un, uk.public_key(), un, uk, ca_exts())
open(f"{D}/root.pem", "wb").write(pem(root))

def san(*items, crit=False):
    return (x509.SubjectAlternativeName(list(items)), crit)
def DNS(s): return x509.DNSName(s)
def IP(s): return x509.IPAddress(ipaddress.ip_address(s))
def NET(s): return x509.IPAddress(ipaddress.ip_network(s))
def URI(s): return x509.UniformResourceIdentifier(s)
def EMAIL(s): return x509.RFC822Name(s)
def DIRN(n): return x509.DirectoryName(n)
def leaf_exts(*sans, eku=[ExtendedKeyUsageOID.SERVER_AUTH], ku=True, bc=True, extra=()):
    ex = []
    if bc: ex.append((x509.BasicConstraints(ca=False, path_length=None), True))
    if ku: ex.append((x509.KeyUsage(True, False, True, False, False, False, False, False, False), True))
    if eku is not None: ex.append((x509.ExtendedKeyUsage(eku), False))
    if sans: ex.append(san(*sans))
    ex.extend(extra)
    return ex

cases = []
def emit(case, host, chain, k):
    open(f"{D}/{case}.pem", "wb").write(b"".join(pem(c) for c in chain))
    open(f"{D}/{case}.key", "wb").write(kpem(k))
    cases.append({"name": case, "host": host})

def simple(case, host, subject, exts, **kw):
    k = kw.pop("k", None) or key()
    c = build(subject, k.public_key(), rn, rk, exts, **kw)
    emit(case, host, [c], k)

# ── host names (leaf straight off R) ────────────────────────────────────
H = "example.com"
simple("base", H, name("whatever"), leaf_exts(DNS(H)))
simple("nul_san", H, name("whatever"), leaf_exts(DNS("example.com\x00.evil.com")))
simple("nul_cn", H, name("example.com\x00.evil.com"), leaf_exts())
simple("nul_san_wild", "a.example.com", name("x"), leaf_exts(DNS("*.example.com\x00.evil.com")))
simple("wild_apex", H, name("x"), leaf_exts(DNS("*.example.com")))
simple("wild_deep", "a.b.example.com", name("x"), leaf_exts(DNS("*.example.com")))
simple("wild_ok", "a.example.com", name("x"), leaf_exts(DNS("*.example.com")))
simple("wild_partial_ok", "xfoo.example.com", name("x"), leaf_exts(DNS("x*.example.com")))
simple("wild_partial_no", "foo.example.com", name("x"), leaf_exts(DNS("x*.example.com")))
simple("wild_star", H, name("x"), leaf_exts(DNS("*")))
simple("wild_tld", "a.com", name("x"), leaf_exts(DNS("*.com")))
simple("wild_mid", "a.b.example.com", name("x"), leaf_exts(DNS("a.*.example.com")))
simple("wild_two", "ab.example.com", name("x"), leaf_exts(DNS("*b*.example.com")))
simple("wild_xn", "xn--abc.example.com", name("x"), leaf_exts(DNS("xn--*.example.com")))
simple("wild_xn2", "xn--abc.example.com", name("x"), leaf_exts(DNS("*.example.com")))
simple("wild_xn_ok", "xn--mnchen-3ya.example.com", name("x"), leaf_exts(DNS("*.example.com")))
simple("case_up", H, name("x"), leaf_exts(DNS("EXAMPLE.COM")))
simple("trail_pat", H, name("x"), leaf_exts(DNS("example.com.")))
simple("trail_host", "example.com.", name("x"), leaf_exts(DNS("example.com")))
simple("comma_san", H, name("x"), leaf_exts(DNS("evil.com, DNS:example.com")))
simple("empty_label", "a.example.com", name("x"), leaf_exts(DNS("a..example.com")))
simple("ip_as_dns", "127.0.0.1", name("x"), leaf_exts(DNS("127.0.0.1")))
simple("ip_cn", "127.0.0.1", name("127.0.0.1"), leaf_exts())
simple("ip_ok", "127.0.0.1", name("x"), leaf_exts(IP("127.0.0.1")))
simple("ip6_ok", "[::1]", name("x"), leaf_exts(IP("::1")))
simple("ip6_mapped_host", "[::ffff:127.0.0.1]", name("x"), leaf_exts(IP("127.0.0.1")))
simple("ip6_mapped_san", "127.0.0.1", name("x"), leaf_exts(IP("::ffff:127.0.0.1")))
simple("ip_wrong", "127.0.0.1", name("x"), leaf_exts(IP("127.0.0.2")))
simple("cn_with_ipsan", H, name(H), leaf_exts(IP("127.0.0.1")))
simple("cn_with_urisan", H, name(H), leaf_exts(URI("https://example.com/")))
simple("cn_with_dnssan", H, name(H), leaf_exts(DNS("other.com")))
simple("cn_only", H, name(H), leaf_exts())
simple("cn_wild", "a.example.com", name("*.example.com"), leaf_exts())
simple("cn_multi_first", H, name(H, "evil.com"), leaf_exts())
simple("cn_multi_last", H, name("evil.com", H), leaf_exts())
simple("cn_two_miss", H, name("a.org", "b.org"), leaf_exts())
simple("cn_bmp", H, x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, H, _ASN1Type.BMPString)]), leaf_exts())
simple("cn_utf8", H, name("exämple.com"), leaf_exts())
simple("no_names", H, x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "o")]), leaf_exts())
simple("del_san", H, name("x"), leaf_exts(DNS("example.com\x7f")))
simple("alt_mix", H, name("x"), leaf_exts(DNS("other.com"), IP("::1"), IP("10.0.0.1"), URI("https://a,b/"), EMAIL("a@b.c"), DIRN(name("dn")), x509.RegisteredID(ObjectIdentifier("1.2.3.4"))))
simple("alt_mix_ip", "127.0.0.1", name("x"), leaf_exts(DNS("other.com"), IP("::1"), IP("10.0.0.1"), URI("https://a,b/"), EMAIL("a@b.c"), DIRN(name("dn")), x509.RegisteredID(ObjectIdentifier("1.2.3.4"))))
# a host past 299 characters: the certificate names only its first 299
LH = ".".join(["b" * 60] * 5) + ".victim.com"
simple("long_trunc", LH, name("x"), leaf_exts(DNS(LH[:299])))
simple("long_ok", LH, name("x"), leaf_exts(DNS(LH)))

# ── chains ──────────────────────────────────────────────────────────────
simple("expired", H, name("x"), leaf_exts(DNS(H)), nb=now - dt.timedelta(days=10), na=now - dt.timedelta(days=1))
simple("future", H, name("x"), leaf_exts(DNS(H)), nb=now + dt.timedelta(days=1), na=now + dt.timedelta(days=10))
simple("eku_client", H, name("x"), leaf_exts(DNS(H), eku=[ExtendedKeyUsageOID.CLIENT_AUTH]))
simple("eku_any", H, name("x"), leaf_exts(DNS(H), eku=[ExtendedKeyUsageOID.ANY_EXTENDED_KEY_USAGE]))
simple("eku_none", H, name("x"), leaf_exts(DNS(H), eku=None))
simple("ku_certsign_only", H, name("x"), [(x509.BasicConstraints(ca=False, path_length=None), True), (x509.KeyUsage(False, False, False, False, False, True, False, False, False), True), san(DNS(H))])
simple("rsa1024", H, name("x"), leaf_exts(DNS(H)), k=key(1024))
simple("sha224", H, name("x"), leaf_exts(DNS(H)), h=hashes.SHA224())
simple("unk_crit", H, name("x"), leaf_exts(DNS(H), extra=[(x509.UnrecognizedExtension(ObjectIdentifier("1.3.6.1.4.1.99999.1"), b"\x05\x00"), True)]))
simple("crit_akid", H, name("x"), leaf_exts(DNS(H), extra=[(x509.AuthorityKeyIdentifier.from_issuer_public_key(rk.public_key()), True)]))
simple("crit_policies", H, name("x"), leaf_exts(DNS(H), extra=[(x509.CertificatePolicies([x509.PolicyInformation(ObjectIdentifier("1.2.3.4"), None)]), True)]))
simple("leaf_is_ca", H, name("x"), [(x509.BasicConstraints(ca=True, path_length=None), True), san(DNS(H))])
simple("eku_expired", H, name("x"), leaf_exts(DNS(H), eku=[ExtendedKeyUsageOID.CLIENT_AUTH]), nb=now - dt.timedelta(days=10), na=now - dt.timedelta(days=2))
ek = ec.generate_private_key(ec.SECP256R1())
simple("ec_leaf", H, name("x"), leaf_exts(DNS(H)), k=ek)

def via_inter(case, host, inter_exts, leaf_ex=None, inter_parent=None, extra_chain=(), leaf_name=None, leaf_nb=None, leaf_na=None):
    ik = key(); inn = name("Inter " + case)
    pn, pk = inter_parent or (rn, rk)
    inter = build(inn, ik.public_key(), pn, pk, inter_exts)
    lk = key()
    leaf = build(leaf_name or name("leaf"), lk.public_key(), inn, ik, leaf_ex or leaf_exts(DNS(host)), nb=leaf_nb, na=leaf_na)
    emit(case, host, [leaf, inter, *extra_chain], lk)

via_inter("inter_ok", H, ca_exts())
via_inter("inter_cafalse", H, ca_exts(ca=False, ku=False))
via_inter("inter_nobc", H, ca_exts(bc=False))
via_inter("inter_nokucs", H, [(x509.BasicConstraints(ca=True, path_length=None), True), (x509.KeyUsage(True, False, False, False, False, False, True, False, False), True)])
via_inter("inter_eku_client", H, ca_exts(eku=[ExtendedKeyUsageOID.CLIENT_AUTH]))
via_inter("inter_eku_any", H, ca_exts(eku=[ExtendedKeyUsageOID.ANY_EXTENDED_KEY_USAGE]))
via_inter("inter_eku_server", H, ca_exts(eku=[ExtendedKeyUsageOID.SERVER_AUTH]))
via_inter("inter_eku_both", H, ca_exts(eku=[ExtendedKeyUsageOID.CLIENT_AUTH, ExtendedKeyUsageOID.SERVER_AUTH]))
NC = x509.NameConstraints
nc = NC(permitted_subtrees=[DNS("allowed.com")], excluded_subtrees=None)
via_inter("nc_noncrit_viol", H, ca_exts(nc=nc, nc_crit=False))
via_inter("nc_crit_viol", H, ca_exts(nc=nc, nc_crit=True))
via_inter("nc_crit_ok", "a.allowed.com", ca_exts(nc=nc, nc_crit=True))
via_inter("nc_excl_noncrit", H, ca_exts(nc=NC(None, [DNS("example.com")]), nc_crit=False))
via_inter("nc_ip_noncrit", "127.0.0.1", ca_exts(nc=NC([NET("10.0.0.0/8")], None), nc_crit=False), leaf_ex=leaf_exts(IP("127.0.0.1")))
via_inter("m_nc_dns_dot_ok", "a.example.com", ca_exts(nc=NC([DNS(".example.com")], None)))
via_inter("m_nc_dns_dot_apex", H, ca_exts(nc=NC([DNS(".example.com")], None)))
via_inter("m_nc_dns_case", H, ca_exts(nc=NC([DNS("EXAMPLE.com")], None)))
via_inter("m_nc_cn_only_viol", H, ca_exts(nc=nc), leaf_ex=leaf_exts(), leaf_name=name(H))
via_inter("m_nc_cn_only_ok", "a.allowed.com", ca_exts(nc=nc), leaf_ex=leaf_exts(), leaf_name=name("a.allowed.com"))
via_inter("m_nc_cn_with_san", H, ca_exts(nc=NC([DNS("example.com")], None)), leaf_name=name("evil.org"))
via_inter("m_nc_ip_excl", "127.0.0.1", ca_exts(nc=NC(None, [NET("127.0.0.0/8")])), leaf_ex=leaf_exts(IP("127.0.0.1"), DNS(H)))
via_inter("m_nc_ip_ok", "127.0.0.1", ca_exts(nc=NC([NET("127.0.0.0/8")], None)), leaf_ex=leaf_exts(IP("127.0.0.1")))
via_inter("m_nc_ip6_v4", "127.0.0.1", ca_exts(nc=NC([NET("::/0")], None)), leaf_ex=leaf_exts(IP("127.0.0.1")))
via_inter("m_nc_email_viol", H, ca_exts(nc=NC([EMAIL("allowed.com")], None)), leaf_ex=leaf_exts(DNS(H), EMAIL("a@evil.com")))
via_inter("m_nc_email_ok", H, ca_exts(nc=NC([EMAIL(".allowed.com")], None)), leaf_ex=leaf_exts(DNS(H), EMAIL("a@x.allowed.com")))
via_inter("m_nc_uri_viol", H, ca_exts(nc=NC([URI("allowed.com")], None)), leaf_ex=leaf_exts(DNS(H), URI("https://evil.com/x")))
via_inter("m_nc_uri_ok", H, ca_exts(nc=NC([URI(".allowed.com")], None)), leaf_ex=leaf_exts(DNS(H), URI("https://a.allowed.com:8/x")))
via_inter("m_nc_uri_bad", H, ca_exts(nc=NC([URI("allowed.com")], None)), leaf_ex=leaf_exts(DNS(H), URI("urn:x")))
GOOD = x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Good Org")])
via_inter("m_nc_dirname_ok", H, ca_exts(nc=NC([DIRN(GOOD)], None)), leaf_name=x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "good  org"), x509.NameAttribute(NameOID.COMMON_NAME, "leaf")]))
via_inter("m_nc_dirname_viol", H, ca_exts(nc=NC([DIRN(GOOD)], None)), leaf_name=x509.Name([x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Bad Org"), x509.NameAttribute(NameOID.COMMON_NAME, "leaf")]))
via_inter("m_nc_excl_dns_sub", "a.example.com", ca_exts(nc=NC(None, [DNS("example.com")])))
via_inter("m_nc_excl_other_type", H, ca_exts(nc=NC(None, [EMAIL("example.com")])))
via_inter("m_nc_two_dns_one_bad", H, ca_exts(nc=NC([DNS("example.com")], None)), leaf_ex=leaf_exts(DNS(H), DNS("evil.org")))
via_inter("m_expired_and_nc", H, ca_exts(nc=nc), leaf_nb=now - dt.timedelta(days=10), leaf_na=now - dt.timedelta(days=2))
via_inter("m_inter_pathlen0_ok", H, ca_exts(path=0))
i0k = key(); i0n = name("Inter P0 parent")
i0 = build(i0n, i0k.public_key(), rn, rk, ca_exts(path=0))
via_inter("pathlen0", H, ca_exts(), inter_parent=(i0n, i0k), extra_chain=(i0,))
via_inter("untrusted_root", H, ca_exts(), inter_parent=(un, uk), extra_chain=(uroot,))
via_inter("v20_missing_root", H, ca_exts(), inter_parent=(un, uk))
sk = key(); sn = name("selfsigned")
emit("selfsigned", H, [build(sn, sk.public_key(), sn, sk, leaf_exts(DNS(H)))], sk)
emit("v_selfsigned_expired", H, [build(sn, sk.public_key(), sn, sk, leaf_exts(DNS(H)), nb=now - dt.timedelta(days=10), na=now - dt.timedelta(days=2))], sk)
emit("v_mimic_root", H, [build(rn, sk.public_key(), rn, sk, leaf_exts(DNS(H)))], sk)
lk = key()
emit("v21_leaf_alone", H, [build(name("leaf"), lk.public_key(), name("Nobody"), uk, leaf_exts(DNS(H)))], lk)
emit("v_alone_expired", H, [build(name("leaf"), lk.public_key(), name("Nobody"), uk, leaf_exts(DNS(H)), nb=now - dt.timedelta(days=10), na=now - dt.timedelta(days=2))], lk)
emit("v7_bad_signature", H, [build(name("leaf"), lk.public_key(), rn, uk, leaf_exts(DNS(H)))], lk)
# trusted intermediate TI (root U untrusted): extra.pem trusts TI
tik = key(); tin = name("Trusted Inter TI")
ti = build(tin, tik.public_key(), un, uk, ca_exts())
lf = build(name("leaf"), lk.public_key(), tin, tik, leaf_exts(DNS(H)))
emit("partial_chain", H, [lf, ti], lk)
emit("partial_chain_leafonly", H, [lf], lk)
ek2 = key(); en = name("Inter expired")
ei = build(en, ek2.public_key(), rn, rk, ca_exts(), nb=now - dt.timedelta(days=10), na=now - dt.timedelta(days=1))
emit("inter_expired", H, [build(name("leaf"), lk.public_key(), en, ek2, leaf_exts(DNS(H))), ei], lk)
v1k = key(); v1n = name("Inter v1")
v1 = (x509.CertificateBuilder().subject_name(v1n).issuer_name(rn).public_key(v1k.public_key())
      .serial_number(x509.random_serial_number()).not_valid_before(now - dt.timedelta(days=1))
      .not_valid_after(now + dt.timedelta(days=30))).sign(rk, hashes.SHA256())
emit("inter_noext", H, [build(name("leaf"), lk.public_key(), v1n, v1k, leaf_exts(DNS(H))), v1], lk)
# the chain sent out of order, with the root, with an expired twin of the intermediate
tk = key(); tn = name("Inter T")
it = build(tn, tk.public_key(), rn, rk, ca_exts())
it_old = build(tn, tk.public_key(), rn, rk, ca_exts(), nb=now - dt.timedelta(days=20), na=now - dt.timedelta(days=5))
lt = build(name("leaf"), lk.public_key(), tn, tk, leaf_exts(DNS(H)))
emit("v_out_of_order", H, [lt, root, it], lk)
emit("v_two_inters", H, [lt, it_old, it], lk)
emit("v_only_old_inter", H, [lt, it_old], lk)

open(f"{D}/extra.pem", "wb").write(pem(root) + pem(ti))
json.dump(cases, open(f"{D}/cases.json", "w"), indent=0)
print(len(cases), "cases")
