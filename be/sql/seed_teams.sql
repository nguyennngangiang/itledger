INSERT INTO teams (team_id, team_name, division) VALUES
  ('0', 'ESG & Sustainability Team', 'ESG & Sustainability Team'),
  ('1', 'Development Merchandising Division', 'Development Merchandising Division'),
  ('2', 'Product Merchandising Division', 'Product Merchandising Division'),
  ('3', 'Factory Management Division', 'Factory Management Division'),
  ('4', 'VN Project Division', 'VN Project Division'),
  ('5', 'Marketing Division', 'Marketing Division'),
  ('6', 'Operation Division', 'Operation Division'),
  ('7', 'VN Strategy & Planning Division', 'VN Strategy & Planning Division'),
  ('8', 'QA Division', 'QA Division'),
  ('9', 'KR Sales Support Team', 'KR Sales Support Team')
ON CONFLICT (team_id) DO UPDATE SET
  team_name = EXCLUDED.team_name,
  division = EXCLUDED.division;
