import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('storage',Path(__file__).resolve().parents[1]/'deploy/storage.py')
s=importlib.util.module_from_spec(spec);spec.loader.exec_module(s)

class StorageTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
  self.key=self.root/'backup.key';self.key.write_text('fixture-only-key')
  self.raw=self.root/'live.sqlite'
  db=sqlite3.connect(self.raw)
  db.executescript('PRAGMA foreign_keys=ON; CREATE TABLE users(id TEXT PRIMARY KEY); CREATE TABLE recipes(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),payload BLOB);')
  db.execute('INSERT INTO users VALUES(?)',('owner',));db.execute('INSERT INTO recipes VALUES(?,?,?)',('recipe','owner',b'image-content'*10000));db.commit();db.close()
  self.before=self.raw.read_bytes()
  self.now=dt.datetime.now(dt.timezone.utc)
 def tearDown(self):self.temp.cleanup()
 def name(self,n=1,suffix='.sqlite.gz.enc'):
  stamp=self.now-dt.timedelta(days=n)
  return self.root/('recipes-'+stamp.strftime('%Y%m%dT%H%M%SZ')+suffix)
 def test_roundtrip_restores_all_bytes_schema_counts_and_blob(self):
  target=self.name();meta=s.encode(self.raw,target,self.key)
  self.assertLess(target.stat().st_size,self.raw.stat().st_size)
  restored=self.root/'restore.sqlite';counts=s.decode(target,restored,self.key,10000)
  self.assertEqual(restored.read_bytes(),self.before);self.assertEqual(counts,{'recipes':1,'users':1})
  self.assertEqual(meta['plainSha256'],s.digest(self.raw));self.assertEqual(self.raw.read_bytes(),self.before)
 def test_both_legacy_kdfs_migrate_without_loss(self):
  for n,iterations in enumerate([10000,200000]):
   old=self.name(n+1,'.sqlite.enc');s.crypt(self.raw,old,self.key,iterations=iterations)
   s.migrate(self.root,'recipes-',iterations)
   self.assertFalse(old.exists());new=old.with_name(old.name.replace('.sqlite.enc','.sqlite.gz.enc'))
   self.assertEqual(s.manifest(new)['plainSha256'],s.digest(self.raw))
 def test_corrupt_legacy_and_wrong_key_preserve_original(self):
  old=self.name(1,'.sqlite.enc');s.crypt(self.raw,old,self.key,iterations=10000);before=old.read_bytes()
  self.key.write_text('wrong')
  with self.assertRaises(RuntimeError):s.migrate(self.root,'recipes-',10000)
  self.assertEqual(old.read_bytes(),before);self.assertEqual(self.raw.read_bytes(),self.before)
 def test_failed_new_verification_does_not_remove_legacy(self):
  old=self.name(1,'.sqlite.enc');s.crypt(self.raw,old,self.key,iterations=10000)
  with patch.object(s,'verify',side_effect=RuntimeError('restore failed')):
   with self.assertRaises(RuntimeError):s.migrate(self.root,'recipes-',10000)
  self.assertTrue(old.exists());self.assertEqual(self.raw.read_bytes(),self.before)
 def test_resume_after_atomic_archive_before_manifest(self):
  old=self.name(1,'.sqlite.enc');s.crypt(self.raw,old,self.key,iterations=10000)
  new=old.with_name(old.name.replace('.sqlite.enc','.sqlite.gz.enc'));s.encode(self.raw,new,self.key);s.metadata_path(new).unlink()
  s.migrate(self.root,'recipes-',10000)
  self.assertFalse(old.exists());self.assertEqual(s.manifest(new)['plainSha256'],s.digest(self.raw))
 def test_corrupted_ciphertext_stops_rotation_before_any_deletion(self):
  for n in range(1,5):s.encode(self.raw,self.name(n),self.key)
  target=self.name(4);meta=s.manifest(target);data=bytearray(target.read_bytes());data[-10]^=1;target.write_bytes(data)
  os.utime(target,ns=(target.stat().st_atime_ns,meta['mtimeNs']))
  with self.assertRaises(RuntimeError):s.rotate(self.root,'recipes-',10**9,10000,True)
  self.assertEqual(len(s.candidates(self.root,'recipes-')),4)
 def test_retention_is_read_only_on_check_and_idempotent_on_apply(self):
  for n in [1,2,3,80,81]:s.encode(self.raw,self.name(n),self.key)
  manual=self.root/'incident.sqlite.enc';manual.write_bytes(b'preserve')
  with self.assertRaises(RuntimeError):s.rotate(self.root,'recipes-',10**9,10000)
  self.assertEqual(len(s.candidates(self.root,'recipes-')),5)
  value=s.rotate(self.root,'recipes-',10**9,10000,True)
  self.assertEqual(value['backups'],3);self.assertEqual(s.rotate(self.root,'recipes-',10**9,10000),value)
  self.assertEqual(manual.read_bytes(),b'preserve');self.assertEqual(self.raw.read_bytes(),self.before)
 def test_time_buckets_and_byte_budget_always_keep_latest_three(self):
  now=dt.datetime.now(dt.timezone.utc);rows=[]
  for n in range(80):
   p=self.root/str(n);p.write_bytes(b'x'*100);rows.append((now-dt.timedelta(hours=n*12),p))
  keep=s.selection(rows,10000,now)
  self.assertLess(len(keep),25);self.assertTrue({p for _,p in rows[:3]}<=keep)
  self.assertEqual(len(s.selection(rows,400,now)),4)
  with self.assertRaises(RuntimeError):s.selection(rows,200,now)
  self.assertEqual(len(list(self.root.glob('[0-9]*'))),80)
 def test_capacity_guard_has_no_side_effects(self):
  with patch.object(s.shutil,'disk_usage',return_value=shutil._ntuple_diskusage(100,99,1)):
   with self.assertRaises(RuntimeError):s.capacity(self.root,10)
  self.assertEqual(self.raw.read_bytes(),self.before)
 def test_only_stale_managed_scratch_directories_are_cleaned(self):
  old=self.root/'.backup-create-crashed';old.mkdir();(old/'snapshot.sqlite').write_bytes(b'partial')
  recent=self.root/'.backup-create-active';recent.mkdir();(recent/'snapshot.sqlite').write_bytes(b'partial')
  manual=self.root/'manual-restore';manual.mkdir();(manual/'saved.sqlite').write_bytes(b'keep')
  for p in [old,manual]:os.utime(p,(0,0))
  s.cleanup_interrupted_work(self.root)
  self.assertFalse(old.exists());self.assertTrue(recent.exists());self.assertTrue(manual.exists())
 def test_low_space_stops_decompression_and_leaves_archive_unchanged(self):
  target=self.name();s.encode(self.raw,target,self.key);before=target.read_bytes()
  with patch.object(s,'capacity',side_effect=RuntimeError('low space')):
   with self.assertRaises(RuntimeError):s.decode(target,self.root/'partial.sqlite',self.key,10000)
  self.assertEqual(target.read_bytes(),before);self.assertEqual(self.raw.read_bytes(),self.before)
 def test_foreign_key_corruption_and_truncation_are_rejected(self):
  db=sqlite3.connect(self.raw);db.execute("INSERT INTO recipes VALUES('bad','missing',NULL)");db.commit();db.close()
  with self.assertRaises(RuntimeError):s.encode(self.raw,self.name(),self.key)
  self.assertFalse(self.name().exists())
 def test_symlink_backup_is_never_followed_or_deleted(self):
  link=self.name(1,'.sqlite.enc')
  try:link.symlink_to(self.raw)
  except OSError:self.skipTest('Symlink privilege unavailable')
  with self.assertRaises(RuntimeError):s.candidates(self.root,'recipes-')
  self.assertEqual(self.raw.read_bytes(),self.before)

if __name__=='__main__':unittest.main()
