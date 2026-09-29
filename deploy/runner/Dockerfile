# Image de base des environnements d'exécution isolés (un conteneur par projet).
# Contient git, le CLI Claude Code et les outils courants ; le code du projet est monté en volume
# au même chemin absolu que sur l'hôte, ce qui évite toute traduction de chemins.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates openssh-client ripgrep jq less procps bash \
 && rm -rf /var/lib/apt/lists/*

# CLI Claude Code (mis à jour en reconstruisant l'image).
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force

# Les conteneurs sont lancés avec l'uid/gid de l'utilisateur hôte ; ce dossier accueille les caches npm.
RUN mkdir -p /tmp/home && chmod 1777 /tmp/home
ENV TERM=xterm-256color LANG=C.UTF-8

CMD ["sleep", "infinity"]
