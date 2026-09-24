// Zaha Missions — connection details.
// Both values are PUBLIC by design: they ship inside the web page, and
// everything they can do is bounded by the row-level security rules in
// schema.sql. Verified 19 Sep 2026: anon can read the board, cannot read
// staff or PINs, and cannot write anything.
//
// The service_role / secret key is NOT here and never will be.
window.MISSIONS = {
  url: 'https://vcgxxxfxgqkkjbhyfqux.supabase.co',
  key: 'sb_publishable_EZydXQhOcbRSRIOdfPyPuA_1QMkQj91',
  site: 'Holborn',
  tz:   'Europe/London'
};
