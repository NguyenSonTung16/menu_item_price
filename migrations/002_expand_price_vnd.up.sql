-- Expand only. v1 keeps reading and writing price while both columns exist.
ALTER TABLE menu_items
  ADD COLUMN price_vnd INTEGER
  CHECK (price_vnd IS NULL OR (typeof(price_vnd) = 'integer' AND price_vnd > 0));
