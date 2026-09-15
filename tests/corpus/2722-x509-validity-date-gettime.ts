// The cert-expiry idiom (portless certs.ts isCertValid): the X509
// validity window in Node's ASN1_TIME_print shape, composed with
// `new Date(dateString).getTime()`. The fixed certificate carries BOTH
// ASN.1 time encodings — a UTCTime notBefore (2026) and a
// GeneralizedTime notAfter (2126, past the 2050 pivot) — so both arms
// print and parse. The date-string parse also covers ECMA's own format
// (date-only UTC, Z and ±HH:MM offsets, expanded years) and answers NaN
// for everything else, like Node's invalid date.
import * as crypto from "node:crypto";

const PEM = `-----BEGIN CERTIFICATE-----
MIIDEzCCAfugAwIBAgIUMsBCFtPck8TATMJzfikgW963q3AwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNdHNuYXRpdmUtdGVzdDAgFw0yNjA3MTcxNzUyMTFaGA8y
MTI2MDYyMzE3NTIxMVowGDEWMBQGA1UEAwwNdHNuYXRpdmUtdGVzdDCCASIwDQYJ
KoZIhvcNAQEBBQADggEPADCCAQoCggEBALRspe2XjtKvNU7Ws5JfqzmTCPmWtfw0
1Uha271hNp/30VstOxWLbpqPrXDvIwJMN4o8CRp92Y1hcmS36m9QS5qfXJFw+n+S
SWGpFdMNvp6hro0OoNBA+anuKWoTsMyHSwe8ND0fyobQbgAXJ0+snmuK0E2ii+CM
IoUqYbK57nHeyHfISLupgrRoNGXjDHv4v+RSr3MJDag6BLA+/yVjkBOBOT6kaE4K
oyNXYYsfFxGnB/4pDSanV/UsfJ4wHXkVn18ndZHIzTsZMUkV4BecF8UaMrP+u8NI
c5wce0uWLFFEneK4q15iVvk9TaY0g1Uj69ryRT3L58W7RYYuHu7cVB0CAwEAAaNT
MFEwHQYDVR0OBBYEFLT2GqaTmxDhntPxMWaUZvA3s9V5MB8GA1UdIwQYMBaAFLT2
GqaTmxDhntPxMWaUZvA3s9V5MA8GA1UdEwEB/wQFMAMBAf8wDQYJKoZIhvcNAQEL
BQADggEBAFcTLVJIyhbIKHfOnGM5T+Kzu5IoDlqzr+Rdx/0IKFLVDqEA9ihEme07
K/d246pOW5LBceVDY2eMikDpIOjYPEoe9C+Ftv5zrCaDw1wtXrq8a7/eS5B+3TzL
k8c1SVVDPIbmViAZNRmnkwCPBsIF9xIfMFhxz4BTJrm/Lt2Hv1GcRBQx/yRK89sj
JiGnsTna//4mPGRGYw+dRCq4tbyr8HbBKdJmbzOCb4CPKfwAMKUpd4e0Ao7jh/BU
EML7B3BEzv5Jw/BT7B39wAfDyhq32PnRnZefF+7pAmpkklHbckBtZtWn02zwQazv
5z62tszZee2i4BouJiyFnb30F6Pebs4=
-----END CERTIFICATE-----
`;

const cert = new crypto.X509Certificate(PEM);
console.log("validFrom:", cert.validFrom);
console.log("validTo:", cert.validTo);
console.log("from ms:", new Date(cert.validFrom).getTime());
console.log("to ms:", new Date(cert.validTo).getTime());

// The isCertValid composition: is the cert still good 30 days out?
const EXPIRY_BUFFER_MS = 30 * 24 * 60 * 60 * 1000;
const expiry = new Date(cert.validTo).getTime();
console.log("valid with buffer:", Date.now() + EXPIRY_BUFFER_MS < expiry);

// The ASN1_TIME_print shape directly — the %2d space-padded day.
console.log(new Date("Jul  1 00:00:00 2026 GMT").getTime());
console.log(new Date("Dec 31 23:59:59 1999 GMT").getTime());
console.log(new Date("Feb 29 12:00:00 2024 GMT").getTime());

// ECMA's date-time string format.
console.log(new Date("2026-07-17T00:00:00.000Z").getTime());
console.log(new Date("2026-07-17T12:34:56Z").getTime());
console.log(new Date("2026-07-17T12:34Z").getTime());
console.log(new Date("2026-07-17").getTime());
console.log(new Date("2026-07").getTime());
console.log(new Date("2026").getTime());
console.log(new Date("2026-07-17T12:00:00+05:30").getTime());
console.log(new Date("2026-07-17T12:00:00-08:00").getTime());
console.log(new Date("+010000-01-01T00:00:00.000Z").getTime());

// Out of range / malformed: NaN, Node's invalid date.
console.log(new Date("bogus").getTime());
console.log(new Date("2026-13-01").getTime());
console.log(new Date("2026-02-30").getTime());
console.log(new Date("Jul 32 00:00:00 2026 GMT").getTime());
console.log(new Date("+275761-01-01T00:00:00.000Z").getTime());
console.log(new Date("2026-02-30T12:00:00Z").getTime());
console.log(new Date("2026-04-31").getTime());
console.log(new Date("2026-00-10").getTime());
console.log(new Date("2026-01-00").getTime());
console.log(new Date("Feb 30 12:00:00 2024 GMT").getTime());
