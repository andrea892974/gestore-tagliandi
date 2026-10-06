const express = require("express");
const ExcelJS = require("exceljs");
const path = require("path");
const mysql = require("mysql2/promise");
const crypto = require("crypto");
const { promisify } = require("util");
require('dotenv').config();


const app = express();
const port = process.env.PORT || 3000;
const scrypt = promisify(crypto.scrypt);
const sessionCookieName = "gestore_tagliandi_session";
const sessionLifetimeMs = 8 * 60 * 60 * 1000;


const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
});

module.exports = pool;



async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS interventi (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL,
        email VARCHAR(255),
        telefono VARCHAR(50) NOT NULL,
        targa VARCHAR(20) NOT NULL,
        modello VARCHAR(255) NOT NULL,
        anno INT NOT NULL,
        chilometraggio INT,
        intervento VARCHAR(100) NOT NULL,
        data_prevista DATE NOT NULL,
        note TEXT,
        privacy BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS Clienti (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL,
        email VARCHAR(255),
        telefono VARCHAR(50) NOT NULL,
        UNIQUE KEY unique_cliente (nome, cognome, telefono)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS autoriparatori (
        id INT AUTO_INCREMENT PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        cognome VARCHAR(100) NOT NULL,
        qualifica VARCHAR(100) NOT NULL,
        mansione VARCHAR(100) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS utenti (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) NOT NULL UNIQUE,
        display_name VARCHAR(100) NOT NULL,
        password_hash VARCHAR(200) NOT NULL,
        ruolo ENUM('admin', 'autoriparatore', 'hr') NOT NULL,
        attivo BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_setup (
        id TINYINT PRIMARY KEY,
        completato BOOLEAN NOT NULL DEFAULT FALSE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    await pool.query("INSERT IGNORE INTO auth_setup (id, completato) VALUES (1, FALSE)");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        token_hash CHAR(64) PRIMARY KEY,
        user_id INT NOT NULL,
        expires_at DATETIME NOT NULL,
        INDEX idx_auth_sessions_expiration (expires_at),
        CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      INSERT INTO autoriparatori (nome, cognome, qualifica, mansione)
      SELECT seed.nome, seed.cognome, seed.qualifica, seed.mansione
      FROM (
        SELECT 'Luca' AS nome, 'Moretti' AS cognome, 'Tecnico meccatronico' AS qualifica, 'Diagnosi elettronica' AS mansione
        UNION ALL SELECT 'Giulia', 'Ferrari', 'Meccanica specializzata', 'Manutenzione motori'
        UNION ALL SELECT 'Marco', 'Conti', 'Tecnico riparatore', 'Frizione e trasmissione'
        UNION ALL SELECT 'Sara', 'Romano', 'Tecnica diagnostica', 'Diagnosi e centraline'
        UNION ALL SELECT 'Andrea', 'Ricci', 'Elettrauto', 'Impianti elettrici'
        UNION ALL SELECT 'Matteo', 'Galli', 'Tecnico pneumatici', 'Pneumatici e convergenza'
        UNION ALL SELECT 'Elena', 'Costa', 'Carrozziere', 'Riparazioni carrozzeria'
        UNION ALL SELECT 'Paolo', 'Marini', 'Meccanico senior', 'Tagliandi e manutenzione'
        UNION ALL SELECT 'Davide', 'Greco', 'Tecnico riparatore', 'Impianti frenanti'
        UNION ALL SELECT 'Francesca', 'Lombardi', 'Responsabile officina', 'Coordinamento lavorazioni'
      ) AS seed
      WHERE NOT EXISTS (SELECT 1 FROM autoriparatori)
    `);

    await pool.query(`
      INSERT INTO Clienti (nome, cognome, email, telefono)
      SELECT DISTINCT i.nome, i.cognome, i.email, i.telefono
      FROM interventi AS i
      ON DUPLICATE KEY UPDATE email = COALESCE(VALUES(email), Clienti.email)
    `);

    console.log("Database pronto");
  } catch (error) {
    console.error("Errore di connessione al database:", error.message);
  }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (error) {
    res.json({ status: "ok", database: "disconnected" });
  }
});

function readSessionToken(req) {
  const cookie = (req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  const token = cookie?.slice(sessionCookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetimeMs / 1000}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
  );
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `${salt.toString("hex")}:${Buffer.from(hash).toString("hex")}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, hashHex] = storedHash.split(":");
  if (!saltHex || !hashHex) return false;
  const expectedHash = Buffer.from(hashHex, "hex");
  const suppliedHash = Buffer.from(await scrypt(password, Buffer.from(saltHex, "hex"), expectedHash.length));
  return expectedHash.length === suppliedHash.length && crypto.timingSafeEqual(expectedHash, suppliedHash);
}

async function createSession(userId, executor = pool) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + sessionLifetimeMs);
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  await executor.execute(
    "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
    [tokenHash, userId, expiresAt]
  );
  return token;
}

async function resolveSessionUser(req) {
  const token = readSessionToken(req);
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const [rows] = await pool.execute(
    `SELECT u.id, u.username, u.display_name, u.ruolo
     FROM auth_sessions AS s
     JOIN utenti AS u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > NOW() AND u.attivo = TRUE`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    req.user = await resolveSessionUser(req);
    if (!req.user) {
      return res.status(401).json({ message: "Autenticazione richiesta." });
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.ruolo)) {
      return res.status(403).json({ message: "Non hai i privilegi necessari per questa operazione." });
    }
    next();
  };
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    ruolo: user.ruolo,
  };
}

app.get("/api/session", async (req, res) => {
  try {
    const [[{ userCount }]] = await pool.query("SELECT COUNT(*) AS userCount FROM utenti");
    const user = await resolveSessionUser(req);
    res.json({ setupRequired: Number(userCount) === 0, user: user ? publicUser(user) : null });
  } catch (error) {
    console.error("Errore durante il controllo della sessione:", error.message);
    res.status(500).json({ message: "Impossibile verificare la sessione." });
  }
});

app.post("/api/auth/setup", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!/^[a-z0-9._-]{3,50}$/.test(username) || !displayName || displayName.length > 100 || password.length < 12) {
    return res.status(400).json({ message: "Inserisci un nome utente valido, un nome visualizzato e una password di almeno 12 caratteri." });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [setupRows] = await connection.execute(
      "SELECT completato FROM auth_setup WHERE id = 1 FOR UPDATE"
    );
    const [users] = await connection.execute("SELECT id FROM utenti LIMIT 1");
    if (!setupRows[0] || setupRows[0].completato || users.length > 0) {
      await connection.rollback();
      return res.status(409).json({ message: "La configurazione iniziale è già stata completata." });
    }

    const passwordHash = await hashPassword(password);
    const [result] = await connection.execute(
      "INSERT INTO utenti (username, display_name, password_hash, ruolo) VALUES (?, ?, ?, 'admin')",
      [username, displayName, passwordHash]
    );
    await connection.execute("UPDATE auth_setup SET completato = TRUE WHERE id = 1");
    const token = await createSession(result.insertId, connection);
    await connection.commit();
    setSessionCookie(res, token);
    res.status(201).json({ message: "Account Admin creato.", user: { id: result.insertId, username, display_name: displayName, ruolo: "admin" } });
  } catch (error) {
    await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Il nome utente è già in uso." });
    }Registra un nuovo intervento.
    console.error("Errore durante la configurazione iniziale:", error.message);
    res.status(500).json({ message: "Errore durante la configurazione iniziale." });
  } finally {
    connection.release();
  }
});

app.post("/api/auth/login", async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  try {
    const [rows] = await pool.execute(
      "SELECT id, username, display_name, password_hash, ruolo FROM utenti WHERE username = ? AND attivo = TRUE",
      [username]
    );
    if (rows.length === 0 || !(await verifyPassword(password, rows[0].password_hash))) {
      return res.status(401).json({ message: "Nome utente o password non validi." });
    }
    await pool.execute("DELETE FROM auth_sessions WHERE expires_at <= NOW()");
    const token = await createSession(rows[0].id);
    setSessionCookie(res, token);
    res.json({ user: publicUser(rows[0]) });
  } catch (error) {
    console.error("Errore durante l'accesso:", error.message);
    res.status(500).json({ message: "Errore durante l'accesso." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = readSessionToken(req);
    if (token) {
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      await pool.execute("DELETE FROM auth_sessions WHERE token_hash = ?", [tokenHash]);
    }
    clearSessionCookie(res);
    res.json({ message: "Sessione terminata." });
  } catch (error) {
    console.error("Errore durante la chiusura della sessione:", error.message);
    res.status(500).json({ message: "Errore durante la chiusura della sessione." });
  }
});

app.use("/api", requireAuth);

app.get("/api/users", requireRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, username, display_name, ruolo, attivo FROM utenti ORDER BY display_name, username"
    );
    res.json(rows);
  } catch (error) {
    console.error("Errore nel recupero degli account:", error.message);
    res.status(500).json({ message: "Errore nel recupero degli account." });
  }
});

app.post("/api/users", requireRole("admin"), async (req, res) => {
  const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
  const displayName = typeof req.body?.display_name === "string" ? req.body.display_name.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const role = req.body?.ruolo;
  if (!/^[a-z0-9._-]{3,50}$/.test(username) || !displayName || displayName.length > 100 || password.length < 12 || !["admin", "autoriparatore", "hr"].includes(role)) {
    return res.status(400).json({ message: "Dati account non validi. La password deve contenere almeno 12 caratteri." });
  }

  try {
    const passwordHash = await hashPassword(password);
    const [result] = await pool.execute(
      "INSERT INTO utenti (username, display_name, password_hash, ruolo) VALUES (?, ?, ?, ?)",
      [username, displayName, passwordHash, role]
    );
    res.status(201).json({ id: result.insertId, username, display_name: displayName, ruolo: role, attivo: 1 });
  } catch (error) {
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "Il nome utente è già in uso." });
    }
    console.error("Errore durante la creazione dell'account:", error.message);
    res.status(500).json({ message: "Errore durante la creazione dell'account." });
  }
});

app.patch("/api/users/:id", requireRole("admin"), async (req, res) => {
  const id = Number(req.params.id);
  const active = req.body?.attivo;
  if (!Number.isSafeInteger(id) || id < 1 || typeof active !== "boolean") {
    return res.status(400).json({ message: "ID o stato account non validi." });
  }
  if (id === req.user.id && !active) {
    return res.status(400).json({ message: "Non puoi disattivare il tuo account." });
  }

  try {
    const [result] = await pool.execute("UPDATE utenti SET attivo = ? WHERE id = ?", [active, id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "Account non trovato." });
    }
    if (!active) await pool.execute("DELETE FROM auth_sessions WHERE user_id = ?", [id]);
    res.json({ id, attivo: active });
  } catch (error) {
    console.error("Errore durante l'aggiornamento dell'account:", error.message);
    res.status(500).json({ message: "Errore durante l'aggiornamento dell'account." });
  }
});

async function exportInterventi(req, res) {
  try {
    let query = `
      SELECT
        id, nome, cognome, email, telefono, targa, modello, anno,
        chilometraggio, intervento,
        DATE_FORMAT(data_prevista, '%Y-%m-%d') AS data_prevista,
        note, privacy,
        DATE_FORMAT(created_at, '%Y-%m-%d %H:%i:%s') AS created_at
      FROM interventi
    `;
    let queryParams = [];

    if (req.method === "POST") {
      const { ids } = req.body || {};
      if (!Array.isArray(ids) || !ids.every((id) => Number.isSafeInteger(id) && id > 0)) {
        return res.status(400).json({ message: "Elenco degli interventi non valido." });
      }

      if (ids.length === 0) {
        query += " WHERE 1 = 0";
      } else {
        const placeholders = ids.map(() => "?").join(", ");
        query += ` WHERE id IN (${placeholders}) ORDER BY FIELD(id, ${placeholders})`;
        queryParams = [...ids, ...ids];
      }
    } else {
      query += " ORDER BY created_at DESC";
    }

    const [rows] = await pool.query(query, queryParams);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Interventi");
    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Nome", key: "nome", width: 18 },
      { header: "Cognome", key: "cognome", width: 18 },
      { header: "Email", key: "email", width: 28 },
      { header: "Telefono", key: "telefono", width: 18 },
      { header: "Targa", key: "targa", width: 14 },
      { header: "Modello", key: "modello", width: 24 },
      { header: "Anno", key: "anno", width: 10 },
      { header: "Chilometraggio", key: "chilometraggio", width: 18 },
      { header: "Intervento", key: "intervento", width: 22 },
      { header: "Data prevista", key: "data_prevista", width: 16 },
      { header: "Note", key: "note", width: 40 },
      { header: "Privacy", key: "privacy", width: 12 },
      { header: "Creato il", key: "created_at", width: 22 },
    ];
    worksheet.addRows(rows.map((row) => ({
      ...row,
      privacy: row.privacy ? "Sì" : "No",
    })));
    worksheet.getRow(1).font = { bold: true };
    worksheet.autoFilter = {
      from: "A1",
      to: `N${Math.max(rows.length + 1, 1)}`,
    };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", 'attachment; filename="interventi.xlsx"')
      .send(Buffer.from(buffer));
  } catch (error) {
    console.error("Errore durante l'esportazione degli interventi:", error.message);
    res.status(500).json({
      message: "Errore durante l'esportazione degli interventi.",
      error: error.message,
    });
  }
}

app.route("/api/interventi/export")
  .get(requireRole("admin", "autoriparatore"), exportInterventi)
  .post(requireRole("admin", "autoriparatore"), exportInterventi);

app.get("/api/interventi", requireRole("admin", "autoriparatore"), async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT * FROM interventi ORDER BY created_at DESC");
    res.json(rows);
  } catch (error) {
    console.error("Errore nel recupero interventi:", error.message);
    res.status(500).json({ message: "Errore nel recupero interventi", error: error.message });
  }
});

app.get("/api/clienti", requireRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, cognome, email, telefono FROM Clienti ORDER BY cognome, nome"
    );
    res.json(rows);
  } catch (error) {
    console.error("Errore nel recupero clienti:", error.message);
    res.status(500).json({ message: "Errore nel recupero clienti", error: error.message });
  }
});

app.get("/api/autoriparatori", requireRole("admin", "hr"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, cognome, qualifica, mansione FROM autoriparatori ORDER BY cognome, nome"
    );
    res.json(rows);
  } catch (error) {
    console.error("Errore nel recupero degli autoriparatori:", error.message);
    res.status(500).json({ message: "Errore nel recupero degli autoriparatori." });
  }
});

function getAutoriparatoreInput(body) {
  const fields = ["nome", "cognome", "qualifica", "mansione"];
  const autoriparatore = Object.fromEntries(
    fields.map((field) => [field, typeof body?.[field] === "string" ? body[field].trim() : ""])
  );
  return fields.every((field) => autoriparatore[field]) ? autoriparatore : null;
}

app.post("/api/autoriparatori", requireRole("admin", "hr"), async (req, res) => {
  const autoriparatore = getAutoriparatoreInput(req.body);
  if (!autoriparatore) {
    return res.status(400).json({ message: "Nome, cognome, qualifica e mansione sono obbligatori." });
  }

  try {
    const [result] = await pool.execute(
      "INSERT INTO autoriparatori (nome, cognome, qualifica, mansione) VALUES (?, ?, ?, ?)",
      [autoriparatore.nome, autoriparatore.cognome, autoriparatore.qualifica, autoriparatore.mansione]
    );
    res.status(201).json({ id: result.insertId, ...autoriparatore });
  } catch (error) {
    console.error("Errore nel salvataggio dell'autoriparatore:", error.message);
    res.status(500).json({ message: "Errore nel salvataggio dell'autoriparatore." });
  }
});

app.put("/api/autoriparatori/:id", requireRole("admin", "hr"), async (req, res) => {
  const id = Number(req.params.id);
  const autoriparatore = getAutoriparatoreInput(req.body);
  if (!Number.isSafeInteger(id) || id < 1 || !autoriparatore) {
    return res.status(400).json({ message: "ID o dati dell'autoriparatore non validi." });
  }

  try {
    await pool.execute(
      "UPDATE autoriparatori SET nome = ?, cognome = ?, qualifica = ?, mansione = ? WHERE id = ?",
      [autoriparatore.nome, autoriparatore.cognome, autoriparatore.qualifica, autoriparatore.mansione, id]
    );
    const [rows] = await pool.execute(
      "SELECT id, nome, cognome, qualifica, mansione FROM autoriparatori WHERE id = ?",
      [id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ message: "Autoriparatore non trovato." });
    }
    res.json(rows[0]);
  } catch (error) {
    console.error("Errore nella modifica dell'autoriparatore:", error.message);
    res.status(500).json({ message: "Errore nella modifica dell'autoriparatore." });
  }
});

app.get("/api/clienti/export", requireRole("admin"), async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT id, nome, cognome, email, telefono FROM Clienti ORDER BY cognome, nome"
    );

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet("Clienti");
    worksheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Nome", key: "nome", width: 18 },
      { header: "Cognome", key: "cognome", width: 18 },
      { header: "Email", key: "email", width: 28 },
      { header: "Telefono", key: "telefono", width: 18 },
    ];
    worksheet.addRows(rows);
    worksheet.getRow(1).font = { bold: true };
    worksheet.autoFilter = {
      from: "A1",
      to: `E${Math.max(rows.length + 1, 1)}`,
    };
    worksheet.views = [{ state: "frozen", ySplit: 1 }];

    const buffer = await workbook.xlsx.writeBuffer();
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .set("Content-Disposition", 'attachment; filename="clienti.xlsx"')
      .send(Buffer.from(buffer));
  } catch (error) {
    console.error("Errore durante l'esportazione dei clienti:", error.message);
    res.status(500).json({
      message: "Errore durante l'esportazione dei clienti.",
      error: error.message,
    });
  }
});

app.post(["/api/interventi", "/api/interventi/add"], requireRole("admin"), async (req, res) => {
  const {
    nome,
    cognome,
    email,
    telefono,
    targa,
    modello,
    anno,
    chilometraggio,
    intervento,
    data,
    note,
    privacy,
  } = req.body;

  const privacyChecked = privacy === "on" || privacy === true || privacy === 1;

  if (!nome || !cognome || !telefono || !targa || !modello || !anno || !intervento || !data || !privacyChecked) {
    return res.status(400).json({
      message: "Dati obbligatori mancanti o privacy non confermata.",
    });
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO Clienti (nome, cognome, email, telefono)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE email = COALESCE(VALUES(email), email)`,
      [
        nome.trim(),
        cognome.trim(),
        email ? email.trim() : null,
        telefono.trim(),
      ]
    );

    const [result] = await connection.execute(
      `INSERT INTO interventi
        (nome, cognome, email, telefono, targa, modello, anno, chilometraggio, intervento, data_prevista, note, privacy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nome.trim(),
        cognome.trim(),
        email ? email.trim() : null,
        telefono.trim(),
        targa.trim().toUpperCase(),
        modello.trim(),
        Number(anno),
        chilometraggio !== "" && chilometraggio != null ? Number(chilometraggio) : null,
        intervento,
        data,
        note ? note.trim() : null,
        true,
      ]
    );
    await connection.commit();

    res.status(201).json({
      message: "Intervento salvato correttamente.",
      id: result.insertId,
    });
  } catch (error) {
    if (connection) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Errore durante l'annullamento del salvataggio:", rollbackError.message);
      }
    }
    console.error("Errore durante il salvataggio dell'intervento:", error.message);
    res.status(500).json({
      message: "Errore durante il salvataggio dell'intervento.",
      error: error.message,
    });
  } finally {
    connection?.release();
  }
});

initDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Server avviato su http://localhost:${port}`);
  });
});