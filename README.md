# Apnée Live

Application de chronométrage collectif pour conférences d'apnée.

## Installation

```bash
cp .env.example .env
docker compose up -d --build
```
Application participant : `/`

Interface administrateur : `/admin`

L'application peut être hébergée sur votre propre
serveur avec Docker.

## Mise à jour

```bash
docker compose up -d --build
```

## Logs

```bash
docker compose logs -f
```

## Sauvegarde

La base SQLite est stockée dans :

```text
./data/apnee-live.sqlite
```

## Accès administrateur

Interface : /admin

Mot de passe par défaut : `Apnée`

Le mot de passe est configurable dans le fichier `.env` :

```env
ADMIN_PASSWORD=VotreMotDePasse
```

Pour une installation publique, il est recommandé de modifier ce mot de passe.

Le fichier `.env` est exclu du dépôt GitHub.

