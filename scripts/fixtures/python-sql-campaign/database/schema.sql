CREATE TABLE imported(id INTEGER PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE import_history(sequence INTEGER PRIMARY KEY, imported_id INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE summary(total INTEGER NOT NULL);
INSERT INTO summary(total) VALUES(0);
CREATE TRIGGER imported_history AFTER INSERT ON imported BEGIN
  INSERT INTO import_history(imported_id,payload) VALUES(NEW.id,NEW.payload);
  UPDATE summary SET total=total+1;
END;
