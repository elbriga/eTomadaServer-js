# Colocar em ~/.local/share/bash-completion/completions/api.sh
_api_sh_completion()
{
    local cur="${COMP_WORDS[COMP_CWORD]}"

    # Completar somente o primeiro argumento (nodo)
    if (( COMP_CWORD != 1 )); then
        return
    fi

    # Buscar hostnames no Raspberry Pi
    local nodos
    nodos=$(cat /etc/etomada.hosts)

    COMPREPLY=( $(compgen -W "$nodos" -- "$cur") )
}

complete -F _api_sh_completion api.sh

