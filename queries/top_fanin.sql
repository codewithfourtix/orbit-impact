-- Functions with the highest in-repo fan-in (most distinct callers).
-- Good candidates for a "what happens if I change this?" demo.
SELECT callee.name, callee.file_path, count(DISTINCT e.source_id) AS callers
FROM gl_edge e
JOIN gl_definition callee
  ON callee.id = e.target_id AND e.target_kind = 'Definition'
WHERE e.relationship_kind = 'CALLS'
GROUP BY callee.name, callee.file_path
ORDER BY callers DESC
LIMIT 15;
