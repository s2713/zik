project(
  'pam_zik_adminlock',
  'c',
  version: '0.0.1',
  license: 'AGPL-3.0-or-later',
  default_options: [
    'c_std=c11',
    'warning_level=3',
    'werror=true',
  ],
)

pam_dep = dependency('pam')

shared_library(
  'pam_zik_adminlock',
  'src/pam_zik_adminlock.c',
  dependencies: [pam_dep],
  name_prefix: '',
  install: false,
)
