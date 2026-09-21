# Implantação no Proxmox VE 8.3

Use um contêiner LXC não privilegiado com Debian 12. Para esta aplicação, 2 vCPU, 2 GB de RAM e 16 GB de disco são suficientes. Marque **Start at boot** e faça o backup do contêiner pelo Proxmox.

## Dependências no contêiner

Instale Node.js 22, Nginx, Git e o cliente MariaDB/MySQL. Confirme `node --version` antes de continuar.

```bash
apt update
apt install -y nginx git mariadb-client
```

## Aplicação e MySQL

```bash
adduser --system --group --home /opt/sisglosa sisglosa
git clone https://github.com/h3nrique-beep/guias-pmgu.git /opt/sisglosa
cd /opt/sisglosa
npm install --omit=dev
install -d -o sisglosa -g sisglosa /etc/sisglosa /opt/sisglosa/data
install -m 600 -o root -g sisglosa .env.example /etc/sisglosa/sisglosa.env
nano /etc/sisglosa/sisglosa.env
```

Preencha `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD` no arquivo `/etc/sisglosa/sisglosa.env`. O usuário do MySQL deve ter acesso somente ao banco `sisglosa`.

Com o banco configurado, inicie uma vez para criar as tabelas:

```bash
sudo -u sisglosa /usr/bin/node server.js
```

Pare com `Ctrl+C`. Para importar as guias atuais, copie o arquivo `data/guias.db` para `/opt/sisglosa/data/guias.db` e execute:

```bash
sudo -u sisglosa env $(grep -v '^#' /etc/sisglosa/sisglosa.env | xargs) /usr/bin/node scripts/migrate-sqlite-to-mysql.js
```

## Serviço e proxy

```bash
install -m 644 deploy/proxmox/sisglosa.service /etc/systemd/system/sisglosa.service
install -m 644 deploy/proxmox/nginx.conf /etc/nginx/sites-available/sisglosa
ln -s /etc/nginx/sites-available/sisglosa /etc/nginx/sites-enabled/sisglosa
rm -f /etc/nginx/sites-enabled/default
systemctl daemon-reload
nginx -t
systemctl enable --now sisglosa nginx
```

O acesso interno é `http://IP_DO_CONTÊINER/`. A aplicação fica limitada a `127.0.0.1:8081`; apenas o Nginx é exposto na rede. Verifique o serviço com:

```bash
curl http://127.0.0.1/health
systemctl status sisglosa
```

Para HTTPS, coloque o nome DNS no `server_name` do Nginx e emita um certificado antes de liberar o acesso externo.
