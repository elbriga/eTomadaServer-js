#!/usr/bin/env bash
# GoPro HERO3+ - fotos a cada 2 min (22h-15h58) e avulsas (17h-21h)
# Cada JPEG vai direto para a pasta diaria no NFS.
set -Eeuo pipefail

# ===== CONFIGURACAO =====
GOPRO_IP="10.5.5.9"
GOPRO_SENHA="goprohero"
WIFI_IFACE="wlan0"
BACKUP="/srv/backup/gopro-grow"
ESTADO="/var/lib/gopro-grow"        # Deve ser disco LOCAL, nao NFS
PERMITIR_FORMATACAO=1             # 0 bloqueia inclusive 'limpar force'
EXIGIR_NFS=1                     # Evita backup no disco do Pi sem o mount
# =========================

URL="http://${GOPRO_IP}"
MEDIA_URL="${URL}:8080"
INDICE="${ESTADO}/sincronizados.tsv"
CAPTURAS="${ESTADO}/capturas.tsv"

declare -A COPIADOS=()

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }
erro() { log "ERRO: $*" >&2; return 1; }

preparar() {
    local dep
    for dep in curl jq jpeginfo exiftool flock findmnt stat date sort comm cmp mktemp; do
        command -v "$dep" >/dev/null || { erro "Dependencia ausente: $dep"; return 1; }
    done
    mkdir -p "$ESTADO/tentativas" "$ESTADO/slots"
    chmod 700 "$ESTADO"

    # Uma unica execucao por vez, inclusive comandos manuais.
    exec 9>"$ESTADO/execucao.lock"
    if ! flock -n 9; then
        log "ROTINA_OCUPADA: execucao anterior ainda ativa; pulando"
        exit 0
    fi
    TMP="$(mktemp -d "$ESTADO/tmp.XXXXXXXX")"
    trap 'rm -rf -- "$TMP"' EXIT
    touch "$INDICE" "$CAPTURAS"
}

verificar_nfs() {
    local tipo prova
    [[ -d "$BACKUP" ]] || { erro "Diretorio BACKUP ausente: $BACKUP"; return 1; }
    if [[ "$EXIGIR_NFS" == 1 ]]; then
        tipo="$(findmnt -rn -T "$BACKUP" -o FSTYPE 2>/dev/null || true)"
        [[ "$tipo" == nfs || "$tipo" == nfs4 ]] || {
            erro "BACKUP nao esta em NFS (tipo=${tipo:-desconhecido}); nada foi gravado"
            return 1
        }
    fi
    prova="$(mktemp "$BACKUP/.gopro-teste.XXXXXXXX")" || {
        erro "NFS indisponivel ou sem permissao de escrita: $BACKUP"
        return 1
    }
    rm -f "$prova"
}

comando() {
    local endereco="${URL}/$1?t=${GOPRO_SENHA}"
    [[ -z "${2:-}" ]] || endereco+="&p=$2"
    curl --noproxy '*' --interface "$WIFI_IFACE" -fsS \
        --connect-timeout 5 --max-time 20 "$endereco" -o /dev/null
}

verificar_conexao() {
    if curl --noproxy '*' --interface "$WIFI_IFACE" -fsS \
        --connect-timeout 3 --max-time 7 "${URL}/bacpac/sd" -o /dev/null; then
        log "GOPRO_ONLINE ip=$GOPRO_IP"
    else
        erro "GOPRO_OFFLINE ip=$GOPRO_IP"
    fi
}

desligar_bip() { comando camera/BS '%00'; log 'BIP_DESLIGADO'; }

acertar_relogio() {
    local aa mm dd hh mi ss v byte payload=""
    read -r aa mm dd hh mi ss <<< "$(date '+%y %m %d %H %M %S')"
    for v in "$aa" "$mm" "$dd" "$hh" "$mi" "$ss"; do
        printf -v byte '%%%02x' "$((10#$v))"
        payload+="$byte"
    done
    comando camera/TM "$payload"
    log 'RELOGIO_SINCRONIZADO'
}

# ===== INVENTARIO =====
listar_midias() {
    local saida="$1" tentativa http
    for tentativa in 1 2 3; do
        http="$(curl --noproxy '*' --interface "$WIFI_IFACE" -LsS \
            --connect-timeout 5 --max-time 30 \
            -o "$saida" -w '%{http_code}' \
            "${MEDIA_URL}/gp/gpMediaList")" || http='000'
        if [[ "$http" == 200 ]] && jq -e '
            (.media | type == "array") and
            all(.media[]; (.d | type == "string") and (.fs | type == "array"))
        ' "$saida" >/dev/null 2>&1; then
            return 0
        fi
        log "INVENTARIO_FALHOU http=$http tentativa=$tentativa/3"
        [[ "$tentativa" == 3 ]] || sleep 3
    done
    return 1
}

# Expande fotos agrupadas de timelapses antigos ainda no cartao.
inventario_tsv() {
    jq -r '
        .media[] | .d as $pasta | .fs[] |
        if (has("g") or has("b") or has("l")) then
            if (has("g") and has("b") and has("l") and (.n | test("^G[0-9]{7}\\.JPG$"))) then
                . as $grupo |
                range(($grupo.b|tonumber); (($grupo.l|tonumber)+1)) as $n |
                [$pasta, ($grupo.n[0:4] + ("0000" + ($n|tostring))[-4:] + ".JPG"), "0"] | @tsv
            else error("Grupo de midias nao suportado") end
        else
            [$pasta, .n, (.s // 0 | tostring)] | @tsv
        end
    ' "$1" | sort -u > "$2"
}

origens_tsv() { awk -F '\t' 'NF >= 2 {print $1 "/" $2}' "$1" | sort -u > "$2"; }

# Identifica fotos cujo obturador respondeu, mas o inventario falhou em seguida.
reconciliar_tentativas() {
    local inventario="$1" antes meta slot novas n origem tipo instante
    origens_tsv "$inventario" "$TMP/todas.txt"
    for antes in "$ESTADO"/tentativas/*.antes; do
        [[ -f "$antes" ]] || continue
        slot="$(basename "$antes" .antes)"
        meta="$ESTADO/tentativas/$slot.meta"
        [[ -f "$meta" ]] || continue
        novas="$(comm -13 "$antes" "$TMP/todas.txt")"
        n="$(printf '%s\n' "$novas" | sed '/^$/d' | wc -l)"
        if [[ "$n" -eq 1 ]]; then
            IFS=$'\t' read -r tipo instante < "$meta"
            origem="$novas"
            printf '%s\t%s\t%s\n' "$origem" "$tipo" "$instante" >> "$CAPTURAS"
            rm -f "$antes" "$meta"
            log "FOTO_IDENTIFICADA origem=$origem tipo=$tipo"
        elif [[ "$n" -gt 1 ]]; then
            log "AVISO: tentativa $slot tem $n arquivos novos; identificacao manual necessaria"
        fi
    done
}

# ===== DISPARO =====
foto_unica() {
    local tipo="$1" slot="$2" instante
    local antes="$ESTADO/tentativas/$slot.antes"
    local meta="$ESTADO/tentativas/$slot.meta"

    if [[ -e "$ESTADO/slots/$slot" ]]; then
        log "FOTO_JA_TENTADA slot=$slot"
        return 0
    fi

    listar_midias "$TMP/antes.json" || { erro 'Inventario indisponivel antes da foto'; return 1; }
    inventario_tsv "$TMP/antes.json" "$TMP/antes.tsv" || return 1
    reconciliar_tentativas "$TMP/antes.tsv"
    origens_tsv "$TMP/antes.tsv" "$antes"

    instante="$(date '+%Y%m%d_%H%M%S')"
    printf '%s\t%s\n' "$tipo" "$instante" > "$meta"

    # Nao repetimos um obturador de resultado incerto.
    touch "$ESTADO/slots/$slot"
    comando camera/CM '%01' || { erro 'Falha ao selecionar modo foto'; return 1; }
    sleep 1
    comando camera/CS '%00' || { erro 'Falha ao selecionar foto unica'; return 1; }
    sleep 1
    comando bacpac/SH '%01' || { erro 'Obturador sem confirmacao; nao repetir automaticamente'; return 1; }
    log "FOTO_DISPARADA tipo=$tipo slot=$slot"
    sleep 3

    if listar_midias "$TMP/depois.json" &&
        inventario_tsv "$TMP/depois.json" "$TMP/depois.tsv"; then
        reconciliar_tentativas "$TMP/depois.tsv"
    else
        log "AVISO: foto disparada, identificacao pendente para proxima execucao"
    fi
}

# ===== NOME E DESTINO =====
# Pastas representam o ciclo iniciado as 22h; 00h-21h59 pertence ao dia anterior.
ciclo_da_foto() {
    local data="${1:0:8}" hora="${1:9:2}"
    local iso="${data:0:4}-${data:4:2}-${data:6:2}"
    if (( 10#$hora >= 22 )); then printf '%s\n' "$iso"
    else date -d "$iso - 1 day" '+%F'; fi
}

carregar_indice() {
    local origem tamanho caminho
    COPIADOS=()
    while IFS=$'\t' read -r origem tamanho caminho; do
        [[ -n "${origem:-}" && -n "${caminho:-}" ]] || continue
        COPIADOS["$origem"]="$tamanho"$'\t'"$caminho"
    done < "$INDICE"
}

# Copia um arquivo atomico (.part -> nome final) no proprio NFS.
baixar_foto() {
    local origem="$1" esperado="$2" destino="$3"
    local tentativa bytes tipo http
    mkdir -p "$(dirname "$destino")" || return 1
    for tentativa in 1 2 3; do
        rm -f "$destino.part"
        http="$(curl --noproxy '*' --interface "$WIFI_IFACE" -fLsS \
            --retry 1 --connect-timeout 5 --max-time 70 \
            -w '%{http_code}' \
            "${MEDIA_URL}/videos/DCIM/${origem}" \
            -o "$destino.part")" || http='000'
        if [[ "$http" == 200 && -f "$destino.part" ]]; then
            bytes="$(stat -c %s "$destino.part")"
            tipo="$(exiftool -s3 -FileType "$destino.part" 2>/dev/null || true)"
            if [[ "$tipo" == JPEG && "$bytes" -gt 0 ]] &&
                jpeginfo -c "$destino.part" >/dev/null 2>&1 &&
                { [[ "$esperado" -eq 0 ]] || [[ "$bytes" -eq "$esperado" ]]; }; then
                mv -f -- "$destino.part" "$destino"
                log "DOWNLOAD_OK arquivo=$origem bytes=$bytes destino=$destino"
                return 0
            fi
            log "DOWNLOAD_INVALIDO origem=$origem esperado=$esperado recebido=$bytes tipo=$tipo tentativa=$tentativa"
        else
            log "DOWNLOAD_FALHOU origem=$origem http=$http tentativa=$tentativa"
        fi
        sleep 2
    done
    erro "Falha de download: $origem (arquivo .part preservado, se existir)"
}

# Importa o que ainda estiver no SD. Cada execucao pula os itens ja copiados.
sincronizar_fotos() {
    local pasta nome tamanho origem linha caminho instante tipo data ciclo destino
    local qt=0
    verificar_nfs || return 1
    listar_midias "$TMP/midias.json" || { erro 'Inventario indisponivel'; return 1; }
    inventario_tsv "$TMP/midias.json" "$TMP/inventario.tsv" || return 1
    reconciliar_tentativas "$TMP/inventario.tsv"
    carregar_indice

    while IFS=$'\t' read -r pasta nome tamanho; do
        [[ -n "${pasta:-}" ]] || continue
        [[ "$pasta" =~ ^[A-Za-z0-9_-]+$ &&
           "$nome" =~ ^[A-Za-z0-9_.-]+\.[Jj][Pp][Ee]?[Gg]$ &&
           "$tamanho" =~ ^[0-9]+$ ]] || {
            erro "Midia nao suportada ou dados invalidos: $pasta/$nome ($tamanho)"
            return 1
        }
        origem="$pasta/$nome"
        linha="${COPIADOS[$origem]:-}"
        if [[ -n "$linha" ]]; then
            IFS=$'\t' read -r data caminho <<< "$linha"
            if [[ "$data" == "$tamanho" && -s "$caminho" ]]; then
                continue
            fi
        fi

        # Primeiro baixa em arquivo temporario no NFS; data EXIF define o nome definitivo.
        # A area temporaria fica na pasta do ciclo atual apenas durante a transferencia.
        local ciclo_atual agora tmpfoto
        agora="$(date '+%Y%m%d_%H%M%S')"
        ciclo_atual="$(ciclo_da_foto "$agora")"
        mkdir -p "$BACKUP/$ciclo_atual"
        tmpfoto="$BACKUP/$ciclo_atual/.download_${pasta}_${nome}"
        baixar_foto "$origem" "$tamanho" "$tmpfoto" || return 1

        tipo='TL'
        instante="$(exiftool -s3 -d '%Y%m%d_%H%M%S' -DateTimeOriginal "$tmpfoto" 2>/dev/null || true)"
        # Para as fotos disparadas pelo script, usa o horario registrado no Raspberry Pi.
        local registro
        registro="$(awk -F '\t' -v id="$origem" '$1==id {print $2 "\t" $3}' "$CAPTURAS" | tail -n 1)"
        if [[ -n "$registro" ]]; then
            IFS=$'\t' read -r tipo instante <<< "$registro"
        fi
        [[ "$instante" =~ ^[0-9]{8}_[0-9]{6}$ ]] || {
            erro "Sem horario confiavel para $origem; preservado $tmpfoto"
            return 1
        }
        ciclo="$(ciclo_da_foto "$instante")"
        destino="$BACKUP/$ciclo/${instante}_${tipo}_${pasta}_${nome}"
        mkdir -p "$(dirname "$destino")"
        if [[ -e "$destino" ]]; then
            # Recupera falha ocorrida depois do mv, antes de registrar o indice.
            if cmp -s -- "$tmpfoto" "$destino"; then
                rm -f -- "$tmpfoto"
            else
                erro "Colisao de nome: $destino (nao sobrescrito)"
                return 1
            fi
        else
            mv -- "$tmpfoto" "$destino"  # Renomeia no mesmo filesystem NFS
        fi
        printf '%s\t%s\t%s\n' "$origem" "$tamanho" "$destino" >> "$INDICE"
        COPIADOS["$origem"]="$tamanho"$'\t'"$destino"
        ((qt+=1))
    done < "$TMP/inventario.tsv"
    log "SINCRONIZACAO_OK novas=$qt"
}

# ===== LIMPEZA =====
# Limpamos o indice apenas apos a GoPro confirmar que o cartao ficou vazio.
limpar_cartao() {
    local tentativa
    [[ "$PERMITIR_FORMATACAO" == 1 ]] || { erro 'LIMPEZA_BLOQUEADA: PERMITIR_FORMATACAO=0'; return 1; }
    log 'LIMPEZA_INICIADA: camera/DA (todas as midias do cartao)'
    if ! comando camera/DA; then
        log 'AVISO: resposta incerta de camera/DA; checando inventario'
    fi
    for tentativa in {1..12}; do
        sleep 5
        if listar_midias "$TMP/apos_limpeza.json" &&
            jq -e '([.media[]?.fs[]?] | length) == 0' "$TMP/apos_limpeza.json" >/dev/null; then
            : > "$INDICE"
            : > "$CAPTURAS"
            rm -f "$ESTADO"/tentativas/*.antes "$ESTADO"/tentativas/*.meta
            log 'CARTAO_LIMPO_CONFIRMADO'
            return 0
        fi
    done
    erro 'LIMPEZA_NAO_CONFIRMADA: confira o cartao antes de continuar'
}

# Compara inventario antes/depois do backup e testa integridade de todos os JPEGs.
validar_backup_para_limpeza() {
    local pasta nome tamanho origem linha esperado caminho
    sincronizar_fotos || return 1
    cp "$TMP/inventario.tsv" "$TMP/validado.tsv"
    listar_midias "$TMP/antes_limpeza.json" || return 1
    inventario_tsv "$TMP/antes_limpeza.json" "$TMP/antes_limpeza.tsv" || return 1
    cmp -s "$TMP/validado.tsv" "$TMP/antes_limpeza.tsv" || {
        erro 'Inventario mudou durante o backup; limpeza bloqueada'
        return 1
    }
    carregar_indice
    while IFS=$'\t' read -r pasta nome tamanho; do
        [[ -n "${pasta:-}" ]] || continue
        origem="$pasta/$nome"
        linha="${COPIADOS[$origem]:-}"
        [[ -n "$linha" ]] || { erro "Sem copia de $origem"; return 1; }
        IFS=$'\t' read -r esperado caminho <<< "$linha"
        [[ "$esperado" == "$tamanho" && -s "$caminho" ]] &&
            jpeginfo -c "$caminho" >/dev/null 2>&1 &&
            { [[ "$tamanho" -eq 0 ]] || [[ "$(stat -c %s "$caminho")" -eq "$tamanho" ]]; } || {
            erro "JPEG nao validado para exclusao: $origem"
            return 1
        }
    done < "$TMP/validado.tsv"

    # Timelapses antigos: o campo 's' informa o tamanho do grupo.
    local p n b l s soma i membro caminho esperado grupo
    jq -r '.media[] | .d as $p | .fs[] | select(has("g") and has("b") and has("l")) | [$p,.n,.b,.l,.s] | @tsv' \
        "$TMP/antes_limpeza.json" > "$TMP/grupos.tsv" || return 1
    while IFS=$'\t' read -r p n b l s; do
        [[ -n "${p:-}" ]] || continue
        [[ "$n" =~ ^G[0-9]{7}\.JPG$ && "$b" =~ ^[0-9]+$ &&
           "$l" =~ ^[0-9]+$ && "$s" =~ ^[0-9]+$ ]] || return 1
        soma=0
        for ((i=10#$b; i<=10#$l; i++)); do
            printf -v membro '%s%04d.JPG' "${n:0:4}" "$i"
            grupo="$p/$membro"
            linha="${COPIADOS[$grupo]:-}"
            [[ -n "$linha" ]] || { erro "Grupo incompleto: $grupo"; return 1; }
            IFS=$'\t' read -r esperado caminho <<< "$linha"
            soma=$((soma + $(stat -c %s "$caminho")))
        done
        [[ "$soma" -eq "$s" ]] || { erro "GRUPO_INCOMPLETO $n esperado=$s recebido=$soma"; return 1; }
    done < "$TMP/grupos.tsv"
    log 'BACKUP_VALIDADO_PARA_LIMPEZA'
}

limpar_interativo() {
    local modo="${1:-}" confirmacao
    [[ -z "$modo" || "$modo" == force ]] || { erro "Argumento invalido: $modo"; return 2; }
    [[ "$PERMITIR_FORMATACAO" == 1 ]] || { erro 'LIMPEZA_CANCELADA: PERMITIR_FORMATACAO=0'; return 1; }
    [[ -t 0 ]] || { erro 'LIMPEZA_CANCELADA: requer terminal'; return 1; }
    if [[ "$modo" == force ]]; then
        printf 'PERIGO: limpar force APAGA O CARTAO SEM BACKUP OU VALIDACAO.\n'
    else
        printf 'Limpeza normal: sincroniza, valida todas as fotos e APAGA O CARTAO.\n'
    fi
    read -r -p 'Digite sim para confirmar: ' confirmacao || return 1
    [[ "$confirmacao" == sim ]] || { erro 'LIMPEZA_CANCELADA: confirmacao diferente de sim'; return 1; }
    verificar_conexao || return 1
    if [[ "$modo" != force ]]; then validar_backup_para_limpeza || return 1; fi
    limpar_cartao
}

# ===== AGENDAMENTO =====
rotina() {
    local hora minuto tipo slot
    hora="$(date +%H)"; minuto="$(date +%M)"
    verificar_conexao || return 1

    # O dia aceso comeca as 22h e termina antes das 16h.
    if (( 10#$hora >= 22 || 10#$hora < 16 )); then
        if (( 10#$minuto % 2 == 0 )); then
            tipo=TL
            slot="$(date '+%Y%m%d_%H%M')"
            if [[ "$hora" == 22 && "$minuto" == 00 ]]; then
                acertar_relogio || return 1
            fi
            foto_unica "$tipo" "$slot" || log "AVISO: falha no disparo do slot $slot"
        fi
    elif (( 10#$hora >= 17 && 10#$hora <= 21 && 10#$minuto == 0 )); then
        tipo=AVULSA
        slot="$(date '+%Y%m%d_%H%M')"
        foto_unica "$tipo" "$slot" || log "AVISO: falha no disparo avulso do slot $slot"
    fi

    # Tenta recuperar capturas anteriores e publica novas fotos no NFS.
    sincronizar_fotos
}

uso() {
    echo "Uso: $0 [cron|status|foto|sincronizar|relogio|bip-off|limpar [force]]"
}

main() {
    preparar || return 1
    case "${1:-}" in
        cron) rotina ;;
        status) verificar_conexao ;;
        foto)
            verificar_conexao || return 1
            foto_unica "${2:-MANUAL}" "manual_$(date '+%Y%m%d_%H%M%S')" || return 1
            sincronizar_fotos
            ;;
        sincronizar) verificar_conexao && sincronizar_fotos ;;
        relogio) verificar_conexao && acertar_relogio ;;
        bip-off) verificar_conexao && desligar_bip ;;
        limpar) limpar_interativo "${2:-}" ;;
        *) uso; return 2 ;;
    esac
}
main "$@"