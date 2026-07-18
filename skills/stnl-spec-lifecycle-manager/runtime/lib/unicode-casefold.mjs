// Full case folding differs from ordinary lowercase for expansions, final
// forms, compatibility letters, and Cherokee.  These overrides are the
// stable full-fold mappings through Unicode 13.0; ordinary one-code-point
// lowercase mappings are supplied by the native String implementation.
const FOLD_OVERRIDES_SOURCE = `
B5:3BC
DF:73,73
149:2BC,6E
17F:73
1F0:6A,30C
345:3B9
390:3B9,308,301
3B0:3C5,308,301
3C2:3C3
3D0:3B2
3D1:3B8
3D5:3C6
3D6:3C0
3F0:3BA
3F1:3C1
3F5:3B5
587:565,582
1C80:432
1C81:434
1C82:43E
1C83:441
1C84:442
1C85:442
1C86:44A
1C87:463
1C88:A64B
1E96:68,331
1E97:74,308
1E98:77,30A
1E99:79,30A
1E9A:61,2BE
1E9B:1E61
1E9E:73,73
1F50:3C5,313
1F52:3C5,313,300
1F54:3C5,313,301
1F56:3C5,313,342
1F80:1F00,3B9
1F81:1F01,3B9
1F82:1F02,3B9
1F83:1F03,3B9
1F84:1F04,3B9
1F85:1F05,3B9
1F86:1F06,3B9
1F87:1F07,3B9
1F88:1F00,3B9
1F89:1F01,3B9
1F8A:1F02,3B9
1F8B:1F03,3B9
1F8C:1F04,3B9
1F8D:1F05,3B9
1F8E:1F06,3B9
1F8F:1F07,3B9
1F90:1F20,3B9
1F91:1F21,3B9
1F92:1F22,3B9
1F93:1F23,3B9
1F94:1F24,3B9
1F95:1F25,3B9
1F96:1F26,3B9
1F97:1F27,3B9
1F98:1F20,3B9
1F99:1F21,3B9
1F9A:1F22,3B9
1F9B:1F23,3B9
1F9C:1F24,3B9
1F9D:1F25,3B9
1F9E:1F26,3B9
1F9F:1F27,3B9
1FA0:1F60,3B9
1FA1:1F61,3B9
1FA2:1F62,3B9
1FA3:1F63,3B9
1FA4:1F64,3B9
1FA5:1F65,3B9
1FA6:1F66,3B9
1FA7:1F67,3B9
1FA8:1F60,3B9
1FA9:1F61,3B9
1FAA:1F62,3B9
1FAB:1F63,3B9
1FAC:1F64,3B9
1FAD:1F65,3B9
1FAE:1F66,3B9
1FAF:1F67,3B9
1FB2:1F70,3B9
1FB3:3B1,3B9
1FB4:3AC,3B9
1FB6:3B1,342
1FB7:3B1,342,3B9
1FBC:3B1,3B9
1FBE:3B9
1FC2:1F74,3B9
1FC3:3B7,3B9
1FC4:3AE,3B9
1FC6:3B7,342
1FC7:3B7,342,3B9
1FCC:3B7,3B9
1FD2:3B9,308,300
1FD3:3B9,308,301
1FD6:3B9,342
1FD7:3B9,308,342
1FE2:3C5,308,300
1FE3:3C5,308,301
1FE4:3C1,313
1FE6:3C5,342
1FE7:3C5,308,342
1FF2:1F7C,3B9
1FF3:3C9,3B9
1FF4:3CE,3B9
1FF6:3C9,342
1FF7:3C9,342,3B9
1FFC:3C9,3B9
FB00:66,66
FB01:66,69
FB02:66,6C
FB03:66,66,69
FB04:66,66,6C
FB05:73,74
FB06:73,74
FB13:574,576
FB14:574,565
FB15:574,56B
FB16:57E,576
FB17:574,56D
`;

const FOLD_OVERRIDES = new Map(
  FOLD_OVERRIDES_SOURCE.trim().split("\n").map((line) => {
    const [source, destination] = line.split(":");
    return [
      Number.parseInt(source, 16),
      String.fromCodePoint(...destination.split(",").map((value) => Number.parseInt(value, 16))),
    ];
  }),
);

function cherokeeFold(codePoint) {
  if (codePoint >= 0x13a0 && codePoint <= 0x13f5) return String.fromCodePoint(codePoint);
  if (codePoint >= 0x13f8 && codePoint <= 0x13fd) return String.fromCodePoint(codePoint - 8);
  if (codePoint >= 0xab70 && codePoint <= 0xabbf) {
    return String.fromCodePoint(0x13a0 + codePoint - 0xab70);
  }
  return null;
}

function isPostContractUppercase(codePoint) {
  return codePoint === 0x1c89 || codePoint === 0x2c2f || codePoint === 0xa7c0 ||
    (codePoint >= 0xa7cb && codePoint <= 0xa7cc) || codePoint === 0xa7d0 ||
    codePoint === 0xa7d6 || codePoint === 0xa7d8 || codePoint === 0xa7da ||
    codePoint === 0xa7dc || (codePoint >= 0x10570 && codePoint <= 0x1057a) ||
    (codePoint >= 0x1057c && codePoint <= 0x1058a) ||
    (codePoint >= 0x1058c && codePoint <= 0x10592) ||
    (codePoint >= 0x10594 && codePoint <= 0x10595) ||
    (codePoint >= 0x10d50 && codePoint <= 0x10d65);
}

export function unicodeCaseFold(value) {
  let folded = "";
  for (const character of String(value).normalize("NFC")) {
    const codePoint = character.codePointAt(0);
    folded += cherokeeFold(codePoint) ?? FOLD_OVERRIDES.get(codePoint) ??
      (isPostContractUppercase(codePoint) ? character : character.toLowerCase());
  }
  return folded;
}
