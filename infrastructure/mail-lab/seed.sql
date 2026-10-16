INSERT INTO users(id,email,password_hash) VALUES('33333333-3333-4333-8333-333333333333','owner@lab.invalid','lab-only-no-login') ON CONFLICT DO NOTHING;
INSERT INTO organizations(id,name,slug) VALUES
 ('11111111-1111-4111-8111-111111111111','Synthetic tenant A','lab-tenant-a'),
 ('22222222-2222-4222-8222-222222222222','Synthetic tenant B','lab-tenant-b') ON CONFLICT DO NOTHING;
INSERT INTO memberships(user_id,organization_id,role) VALUES
 ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','owner') ON CONFLICT DO NOTHING;
INSERT INTO domains(id,organization_id,name,verification_token,verification_status) VALUES
 ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','tenant-a.lab.invalid','synthetic-fixture','verified'),
 ('66666666-6666-4666-8666-666666666666','22222222-2222-4222-8222-222222222222','tenant-b.lab.invalid','synthetic-fixture','verified') ON CONFLICT DO NOTHING;
INSERT INTO mailboxes(id,domain_id,local_part,desired_revision) VALUES
 ('55555555-5555-4555-8555-555555555555','44444444-4444-4444-8444-444444444444','pilot',1) ON CONFLICT DO NOTHING;
-- Explicit fixture activation is separate from ownership. No public activation API.
UPDATE domains SET mail_activation='local-lab' WHERE id IN ('44444444-4444-4444-8444-444444444444','66666666-6666-4666-8666-666666666666') AND verification_status='verified' AND status='active';
INSERT INTO provisioning_requests(id,mailbox_id,operation,quota_mb,revision,desired_status) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','55555555-5555-4555-8555-555555555555','create',100,1,'active') ON CONFLICT DO NOTHING;
