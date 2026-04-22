/*
 * pam_zik_adminlock.c — PAM account/auth module enforcing the admin-only lock.
 *
 * FIXME(P6.3): This is an M0.1 skeleton. It currently returns PAM_SUCCESS
 * unconditionally and therefore MUST NOT ship on target 2. The real
 * implementation consults /var/lib/zik/adminlock (mode 0644, owned by root,
 * written only by zik-privhelp) and returns PAM_AUTH_ERR when the lock is
 * active and the user being authenticated is not "admin".
 */

#include <security/pam_appl.h>
#include <security/pam_modules.h>

PAM_EXTERN int
pam_sm_authenticate(pam_handle_t *pamh, int flags, int argc, const char **argv)
{
    (void)pamh;
    (void)flags;
    (void)argc;
    (void)argv;
    /* FIXME(P6.3): check /var/lib/zik/adminlock and enforce. */
    return PAM_SUCCESS;
}

PAM_EXTERN int
pam_sm_setcred(pam_handle_t *pamh, int flags, int argc, const char **argv)
{
    (void)pamh;
    (void)flags;
    (void)argc;
    (void)argv;
    return PAM_SUCCESS;
}
