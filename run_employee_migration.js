const mysql = require('mysql2');
const connection = mysql.createConnection({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'smartlocker',
  multipleStatements: true
});

const statements = [
  "ALTER TABLE employee ADD COLUMN IF NOT EXISTS employeeType INT DEFAULT 0",
  "ALTER TABLE employee ADD COLUMN IF NOT EXISTS organization VARCHAR(255) DEFAULT ''",
  "ALTER TABLE employee ADD COLUMN IF NOT EXISTS tradeName VARCHAR(255) DEFAULT ''"
];

connection.connect((err) => {
  if (err) return console.error(err);
  console.log('Connected.');
  
  let completed = 0;
  statements.forEach(stmt => {
    connection.query(stmt, (err) => {
      if (err) console.error(err.message);
      else console.log('Success:', stmt);
      
      completed++;
      if (completed === statements.length) connection.end();
    });
  });
});
