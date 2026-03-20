sqlite3 data/agent.db "SELECT id, substr(title, 1, 40), length(content) FROM posts ORDER BY id DESC LIMIT 10;"
sqlite3 data/agent.db "DELETE FROM posts WHERE title LIKE 'TTT%' OR title = 'Test' OR title = 'Test title';"
