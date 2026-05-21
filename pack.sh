#!/usr/bin/env bash
# pack.sh — empacota a extensão Canopus Reserva Robô para distribuição via GitHub Releases
#
# Uso:
#   ./pack.sh                  → usa key.pem existente (mantém o mesmo extension ID)
#   ./pack.sh --new-key        → gera nova key.pem (NOVO extension ID — só na 1ª vez!)
#
# Saídas em dist/:
#   - canopus-reserva-robo.crx          (extensão assinada)
#   - update_manifest.xml               (com EXTENSION_ID e versão substituídos)
#   - install.bat                       (com EXTENSION_ID substituído)
#   - canopus-reserva-robo-vX.Y.Z.zip   (pacote completo pra release)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSION_DIR="$ROOT/extension"
KEY_PEM="$ROOT/key.pem"
DIST_DIR="$ROOT/dist"
CRX_OUT="$DIST_DIR/canopus-reserva-robo.crx"

NEW_KEY=0
if [[ "${1:-}" == "--new-key" ]]; then
  NEW_KEY=1
fi

# ─── Pré-requisitos ───────────────────────────────────────────────────────────
if ! command -v openssl >/dev/null 2>&1; then
  echo "[X] openssl não encontrado. Instale (apt install openssl)."
  exit 1
fi
if ! command -v zip >/dev/null 2>&1; then
  echo "[X] zip não encontrado. Instale (apt install zip)."
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "[X] python3 não encontrado (necessário pra empacotar .crx)."
  exit 1
fi
if [[ ! -f "$EXTENSION_DIR/manifest.json" ]]; then
  echo "[X] $EXTENSION_DIR/manifest.json não encontrado."
  exit 1
fi

# ─── Versão do manifest ───────────────────────────────────────────────────────
VERSION=$(python3 -c "import json; print(json.load(open('$EXTENSION_DIR/manifest.json'))['version'])")
EXTNAME=$(python3 -c "import json; print(json.load(open('$EXTENSION_DIR/manifest.json'))['name'])")

echo "============================================================"
echo "  PACK: $EXTNAME v$VERSION"
echo "============================================================"
echo

# ─── Chave privada ────────────────────────────────────────────────────────────
if [[ $NEW_KEY -eq 1 ]]; then
  if [[ -f "$KEY_PEM" ]]; then
    read -r -p "[!] key.pem JÁ existe. Sobrescrever vai INVALIDAR o extension ID atual. Continuar? (s/N): " CONFIRM
    if [[ "${CONFIRM,,}" != "s" ]]; then
      echo "Abortado."
      exit 1
    fi
  fi
  echo "[1/5] Gerando nova chave privada RSA 2048..."
  openssl genrsa -out "$KEY_PEM" 2048 2>/dev/null
  chmod 600 "$KEY_PEM"
  echo "      Salvo em: $KEY_PEM"
elif [[ ! -f "$KEY_PEM" ]]; then
  echo "[X] key.pem não encontrada."
  echo "    Rode './pack.sh --new-key' para gerar a primeira vez."
  echo "    DEPOIS de gerar, guarde key.pem em local seguro — perdê-la"
  echo "    significa novo extension ID e reinstalação em todos os clientes."
  exit 1
else
  echo "[1/5] Usando key.pem existente."
fi

# ─── Extension ID (deterministic from public key) ─────────────────────────────
# Algoritmo Chrome: SHA-256(DER public key) → primeiros 32 hex chars → mapear 0-f para a-p
EXT_ID=$(openssl rsa -in "$KEY_PEM" -pubout -outform DER 2>/dev/null \
  | openssl dgst -sha256 -binary \
  | xxd -p -c 256 \
  | head -c 32 \
  | tr '0-9a-f' 'a-p')

echo "[2/5] Extension ID: $EXT_ID"

# ─── Diretório dist limpo ─────────────────────────────────────────────────────
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

# ─── Empacotar .crx via Python (CRX3 format) ──────────────────────────────────
# CRX3 magic + header (proto-encoded sha256_with_rsa signature) + zip payload.
echo "[3/5] Empacotando extensão em .crx..."

# Primeiro: zipar conteúdo da pasta extension/ (excluindo tests, src/, etc.)
# mktemp -u: gera o nome mas NÃO cria o arquivo (zip recusa arquivo vazio existente)
TMP_ZIP=$(mktemp -u --suffix=.zip)
( cd "$EXTENSION_DIR" && zip -qr "$TMP_ZIP" . -x "tests/*" "src/*" "*.DS_Store" "*.map" )

# Depois: usar Python pra montar CRX3
python3 - <<PYEOF "$KEY_PEM" "$TMP_ZIP" "$CRX_OUT"
import sys, struct, hashlib, subprocess

key_pem, zip_path, crx_out = sys.argv[1], sys.argv[2], sys.argv[3]

# Extrair public key DER
pub_der = subprocess.check_output(
    ["openssl", "rsa", "-in", key_pem, "-pubout", "-outform", "DER"],
    stderr=subprocess.DEVNULL,
)

# Ler ZIP
with open(zip_path, "rb") as f:
    zip_data = f.read()

# Montar SignedData (proto)
# message SignedData { bytes crx_id = 1; }
# crx_id = primeiros 16 bytes do sha256(public_key)
crx_id = hashlib.sha256(pub_der).digest()[:16]
signed_data = b"\x0a" + bytes([len(crx_id)]) + crx_id

# signed_header_data inclui length-prefix do signed_data
signed_header_data = signed_data

# Assinar: sha256_with_rsa sobre "CRX3 SignedData\x00" + signed_header_data + zip_data
# Spec: https://source.chromium.org/chromium/chromium/src/+/main:components/crx_file/crx3.proto
signed_payload = b"CRX3 SignedData\x00" + struct.pack("<I", len(signed_header_data)) + signed_header_data + zip_data

# Assinar com SHA-256 RSA via openssl
sign_proc = subprocess.run(
    ["openssl", "dgst", "-sha256", "-sign", key_pem],
    input=signed_payload, capture_output=True, check=True,
)
signature = sign_proc.stdout

# Montar AsymmetricKeyProof: { public_key=1 (bytes), signature=2 (bytes) }
def proto_bytes(field_num, data):
    tag = (field_num << 3) | 2  # wire type 2 (length-delimited)
    return bytes([tag]) + encode_varint(len(data)) + data

def encode_varint(n):
    out = b""
    while True:
        b = n & 0x7f
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            out += bytes([b])
            return out

proof = proto_bytes(1, pub_der) + proto_bytes(2, signature)

# CrxFileHeader: { sha256_with_rsa = 2 (repeated AsymmetricKeyProof), signed_header_data = 10000 (bytes) }
def proto_message(field_num, msg_bytes):
    return proto_bytes(field_num, msg_bytes)

# Field 2 (repeated): sha256_with_rsa = AsymmetricKeyProof
# Field 10000: signed_header_data
header = proto_message(2, proof)
# field 10000 = signed_header_data — tag para field 10000 wire type 2:
# (10000 << 3) | 2 = 80002. Varint encode:
def encode_tag(field_num, wire_type):
    return encode_varint((field_num << 3) | wire_type)
header += encode_tag(10000, 2) + encode_varint(len(signed_header_data)) + signed_header_data

# CRX3 file: magic "Cr24" + version(3) + header_length + header + zip
with open(crx_out, "wb") as f:
    f.write(b"Cr24")
    f.write(struct.pack("<I", 3))            # version
    f.write(struct.pack("<I", len(header)))  # header length
    f.write(header)
    f.write(zip_data)

print(f"      .crx criado: {crx_out} ({len(open(crx_out, 'rb').read())} bytes)")
PYEOF

rm -f "$TMP_ZIP"

# ─── Substituir placeholders em update_manifest.xml + install.bat ─────────────
echo "[4/5] Gerando update_manifest.xml e install.bat com EXTENSION_ID..."

UPDATE_URL="https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/update_manifest.xml"
CRX_URL="https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/canopus-reserva-robo.crx"

sed -e "s|EXTENSION_ID_PLACEHOLDER|$EXT_ID|g" \
    -e "s|version='1.0.0'|version='$VERSION'|g" \
    -e "s|https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/canopus-reserva-robo.crx|$CRX_URL|g" \
    "$ROOT/update_manifest.xml" > "$DIST_DIR/update_manifest.xml"

sed -e "s|EXTENSION_ID_PLACEHOLDER|$EXT_ID|g" \
    -e "s|https://github.com/wellingtonpoll/canopus-reserva-robo/releases/latest/download/update_manifest.xml|$UPDATE_URL|g" \
    "$ROOT/install.bat" > "$DIST_DIR/install.bat"

# ─── Zipar pacote final ───────────────────────────────────────────────────────
echo "[5/5] Criando pacote zip..."
PKG_ZIP="$DIST_DIR/canopus-reserva-robo-v$VERSION.zip"
( cd "$DIST_DIR" && zip -qj "$PKG_ZIP" install.bat update_manifest.xml canopus-reserva-robo.crx )

echo
echo "============================================================"
echo "  PACK CONCLUÍDO"
echo "============================================================"
echo
ls -la "$DIST_DIR"
echo
echo "Extension ID:    $EXT_ID"
echo "Versão:          $VERSION"
echo "Pacote pronto:   $PKG_ZIP"
echo
echo "============================================================"
echo "  CHECKLIST GITHUB RELEASE"
echo "============================================================"
echo
echo "  1. git tag v$VERSION && git push origin v$VERSION"
echo
echo "  2. GitHub.com → Releases → Draft a new release:"
echo "     - Tag:   v$VERSION"
echo "     - Title: v$VERSION"
echo "     - Anexar individualmente (NÃO o zip — o instalador precisa de URLs diretas):"
echo "         • dist/canopus-reserva-robo.crx"
echo "         • dist/update_manifest.xml"
echo "         • dist/install.bat"
echo "     - Body: changelog da versão"
echo "     - Marcar 'Latest release' (importante — o instalador usa /latest/download/)"
echo
echo "  3. Após publicar, validar URLs:"
echo "     curl -I $CRX_URL"
echo "     curl -I $UPDATE_URL"
echo "     (devem responder HTTP 302 → 200)"
echo
echo "  4. Enviar pro cliente:"
echo "     • Link do install.bat na release"
echo "     • Instruções: clicar 2x → autorizar elevação"
echo
echo "============================================================"
echo
echo "  IMPORTANTE:"
echo "  - key.pem é SEGREDO. Backup em local seguro. Perdê-la =="
echo "    novo extension ID + reinstalação manual em todos os clientes."
echo "  - Para novas versões: bump version no manifest.json e rode ./pack.sh"
echo
