const mysql = require('mysql2');
const fs = require('fs');
const path = require('path');

const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'smartlocker',
  multipleStatements: true
});

connection.connect((err) => {
  if (err) {
    console.error('Error connecting to DB:', err);
    return;
  }
  console.log('Connected to the database.');

  const sqlPath = path.join(__dirname, '../migrate_db.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  // Basic parsing for multiple statements if multipleStatements is not fully working
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  
  let completed = 0;
  let hasError = false;

  statements.forEach((stmt, index) => {
    connection.query(stmt, (err, results) => {
      if (err) {
        console.error(`Error executing statement ${index + 1}:`, err.message);
        hasError = true;
      } else {
        console.log(`Executed statement ${index + 1} successfully.`);
      }

      completed++;
      if (completed === statements.length) {
        console.log('Migration finished.');
        connection.end();
      }
    });
  });
});
