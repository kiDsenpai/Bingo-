import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return json({ error: 'Missing authorization' }, 401);
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const resendKey = Deno.env.get('RESEND_API_KEY');
    const fromEmail = Deno.env.get('WELCOME_FROM_EMAIL') || 'Bingo <onboarding@resend.dev>';

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userError } = await userClient.auth.getUser();
    if (userError || !user) {
      return json({ error: 'Not signed in' }, 401);
    }

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: profile, error: profileError } = await admin
      .from('profiles')
      .select('id, username, bingo_uid, email, welcome_email_sent_at')
      .eq('id', user.id)
      .single();

    if (profileError) throw profileError;
    if (!profile?.username || !profile.email) {
      return json({ skipped: true, reason: 'profile-incomplete' });
    }
    if (profile.welcome_email_sent_at) {
      return json({ skipped: true, reason: 'already-sent' });
    }

    if (!resendKey) {
      return json({ error: 'RESEND_API_KEY is not configured' }, 500);
    }

    const username = profile.username;
    const uid = profile.bingo_uid;
    const text = [
      'Welcome to BINGO!',
      '',
      'Your account has been successfully created.',
      '',
      `Username: @${username}`,
      `Bingo UID: ${uid}`,
      '',
      'You are ready to play.',
    ].join('\n');

    const html = `
      <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.6;">
        <h1 style="letter-spacing: -0.04em;">Welcome to BINGO!</h1>
        <p>Your account has been successfully created.</p>
        <p>
          Username: <strong>@${username}</strong><br>
          Bingo UID: <strong>${uid}</strong>
        </p>
        <p>You are ready to play.</p>
      </div>
    `;

    const emailResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromEmail,
        to: [profile.email],
        subject: 'Welcome to BINGO!',
        text,
        html,
      }),
    });

    if (!emailResponse.ok) {
      const details = await emailResponse.text();
      throw new Error(`Email provider error: ${details}`);
    }

    const { error: updateError } = await admin
      .from('profiles')
      .update({ welcome_email_sent_at: new Date().toISOString() })
      .eq('id', user.id)
      .is('welcome_email_sent_at', null);

    if (updateError) throw updateError;

    return json({ sent: true });
  } catch (error) {
    return json({ error: error.message || 'Could not send welcome email' }, 500);
  }
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
