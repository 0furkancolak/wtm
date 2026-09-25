-- How a supervised run ended, when the daemon saw it end: the task's own exit status, or the
-- signal that ended it. Both stay NULL for a run stopped on request and for one whose end was
-- never observed, so a NULL is "not known", never "exited 0".
ALTER TABLE managed_processes ADD COLUMN exit_code INTEGER;

ALTER TABLE managed_processes ADD COLUMN exit_signal TEXT;
