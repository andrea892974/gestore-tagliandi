# Gestore tagliandi

## Prerequisiti

- Node.js e npm
- Docker e Docker Compose
docker exec -it mysql-dev mysql -uutente -ppassword -Dmiodb
## Avvio del progetto

1. Installare le dipendenze:

	```sh
	npm install
	```

2. Avviare il container MySQL in background:

	```sh
	docker compose up -d mysql
	```

3. Controllare che il container sia attivo:

	```sh
	docker compose ps
	```

	Il servizio `mysql` deve avere stato `Up`.

4. Verificare che MySQL accetti connessioni:

	```sh
	docker exec mysql-dev mysqladmin ping -uutente -ppassword
	```

	Il risultato atteso è `mysqld is alive`.

5. Avviare l'applicazione:

	```sh
	npm run dev
	```

	Il comando avvia MySQL, attende che accetti connessioni (fino a 30 secondi) e avvia il server. L'app sarà disponibile su [http://localhost:3000](http://localhost:3000/).

## Test dell'app e del database

Con l'applicazione in esecuzione, verificare la connessione al database:

```sh
curl http://localhost:3000/api/health
```

Risultato atteso:

```json
{"status":"ok","database":"connected"}
```

Per controllare direttamente le tabelle del database:

```sh

```

Nella console MySQL eseguire:

```sql
SHOW TABLES;
DESCRIBE interventi;
DESCRIBE autoriparatori;
SELECT COUNT(*) FROM interventi;
SELECT * FROM interventi;
```

La tabella `interventi` viene creata automaticamente all'avvio di `server.js`. Viene creata anche la tabella `Clienti`, inizializzata con i clienti già presenti negli interventi. I nuovi interventi aggiornano la rubrica; il pulsante **Rubrica** nel modulo consente di selezionare un cliente e compilare i relativi dati.

La tabella `autoriparatori` viene creata automaticamente e, se vuota, inizializzata con 10 record di esempio. Il pulsante **Gestisci autoriparatori** consente di consultare l'elenco, inserire nuovi record e modificare quelli esistenti.

Nella sezione **Visualizza tutti gli interventi**, una ricerca immediata filtra gli interventi in base a qualsiasi campo visualizzato, come nome, targa, tipo di intervento o note. Il pulsante **Esporta in Excel** scarica in formato `.xlsx` solo i risultati corrispondenti al filtro corrente. Nel pannello **Rubrica**, il pulsante **Esporta in Excel** scarica tutti i clienti registrati, con i relativi dati di contatto, in un file `.xlsx`.

## Log e arresto

Per visualizzare i log di MySQL:

```sh
docker compose logs -f mysql
```

Per arrestare il database:

```sh
docker compose stop mysql
```

Per arrestare e rimuovere il container senza cancellare i dati:

```sh
docker compose down
```

Il volume `mysql_data` conserva i dati del database tra gli avvii.

## Accesso e ruoli

Al primo avvio, la pagina richiede di creare l'account **Admin** iniziale. La password deve contenere almeno 12 caratteri; non sono previste credenziali predefinite. Dopo l'accesso, l'Admin può creare account, assegnare un ruolo e disattivare gli account non più necessari.

- **Admin**: accesso completo a interventi, clienti, autoriparatori e account.
- **Autoriparatore**: consultazione ed esportazione degli interventi, senza possibilità di modificarli.
- **Risorse umane**: consultazione, inserimento e modifica dell'anagrafica autoriparatori.

Le password sono memorizzate con hash scrypt; le sessioni sono conservate nel database e scadono dopo 8 ore. Le autorizzazioni sono verificate dal server per ogni API, oltre alla visibilità delle funzioni nell'interfaccia.
