import { useMutation } from '@apollo/client';
import { useState } from 'react';
import { Alert, Badge, Button, Form, Table } from 'react-bootstrap';
import { useAuth } from '../auth/AuthContext';
import { useDialogs } from '../components/Dialogs';
import PageLoading from '../components/PageLoading';
import { DELETE_USER, INVITE_USER, SET_USER_ADMIN, SET_USER_SUPER_ADMIN, USERS } from '../graphql/misc';
import type { User } from '../graphql/operations';
import { timeAgo } from '../lib/humanize';
import { usePollingQuery } from '../lib/usePollingQuery';
import { useTabTitle } from '../workbench/TabsContext';

type Role = 'user' | 'admin' | 'super';
const roleOf = (u: User): Role => (u.isSuperAdmin ? 'super' : u.isAdmin ? 'admin' : 'user');

/** Utilisateurs de l'application (administrateurs) : invitations, rôles, suppression. */
export default function UsersPage() {
  const { user: me } = useAuth();
  const { confirm, showError } = useDialogs();
  const { data, loading, error } = usePollingQuery<{ users: User[] }>(USERS, { pollInterval: 15_000 });
  useTabTitle('Utilisateurs');
  const [email, setEmail] = useState('');
  const [asAdmin, setAsAdmin] = useState(false);
  const refetch = { refetchQueries: ['Users'] };
  const [invite, { loading: inviting, error: inviteError }] = useMutation(INVITE_USER, { ...refetch, onCompleted: () => setEmail('') });
  const [setAdmin] = useMutation(SET_USER_ADMIN, { ...refetch, onError: (e) => void showError(e) });
  const [setSuperAdmin] = useMutation(SET_USER_SUPER_ADMIN, { ...refetch, onError: (e) => void showError(e) });
  const [deleteUser] = useMutation(DELETE_USER, { ...refetch, onError: (e) => void showError(e) });

  const changeRole = async (u: User, role: Role) => {
    const current = roleOf(u);
    if (role === current) return;
    if (role === 'super') return setSuperAdmin({ variables: { userId: u.id, isSuperAdmin: true } });
    if (current === 'super') await setSuperAdmin({ variables: { userId: u.id, isSuperAdmin: false } });
    if (role === 'user') return setAdmin({ variables: { userId: u.id, isAdmin: false } });
    if (!u.isAdmin || current === 'super') return setAdmin({ variables: { userId: u.id, isAdmin: true } });
  };

  if (loading && !data) return <PageLoading />;
  if (error) return <Alert variant="danger">Erreur : {error.message}</Alert>;
  const users = data?.users ?? [];
  return (
    <>
      <h1 className="h3">Utilisateurs</h1>
      <p className="text-secondary small">
        Personne ne s'inscrit seul : un compte existe parce qu'il a été invité ici ou sur un projet. Un administrateur accède aux paramètres généraux et à cette page ; un super administrateur est un administrateur qui administre aussi
        tous les projets, membre ou non : ils apparaissent tous sur sa page Projets et dans sa recherche. Seul un super administrateur accorde ou retire ce rôle.
      </p>
      <Form
        className="d-flex gap-2 align-items-center mb-3 flex-wrap"
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) invite({ variables: { email: email.trim(), isAdmin: asAdmin } });
        }}
      >
        <Form.Control type="email" size="sm" placeholder="adresse@exemple.fr" value={email} onChange={(e) => setEmail(e.target.value)} style={{ width: 280 }} required />
        <Form.Check type="checkbox" id="invite-admin" label="administrateur" checked={asAdmin} onChange={(e) => setAsAdmin(e.target.checked)} />
        <Button size="sm" type="submit" disabled={inviting || !email.trim()}>
          Inviter
        </Button>
        {inviteError && <span className="text-danger small">{inviteError.message}</span>}
      </Form>
      <Table size="sm" hover responsive>
        <thead>
          <tr>
            <th>Utilisateur</th>
            <th>Rôle</th>
            <th className="d-none d-md-table-cell">Invité</th>
            <th className="d-none d-md-table-cell">Dernière connexion</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const self = u.id === me?.id;
            const locked = self || (u.isSuperAdmin && !me?.isSuperAdmin);
            return (
              <tr key={u.id}>
                <td>
                  <div className="d-flex align-items-center gap-2">
                    {u.avatarUrl ? <img src={u.avatarUrl} alt="" className="wb-avatar" referrerPolicy="no-referrer" /> : <span className="wb-avatar wb-avatar-initials">{u.name.slice(0, 2).toUpperCase()}</span>}
                    <span>
                      {u.name}
                      {self && <span className="text-secondary"> (vous)</span>}
                      <div className="small text-secondary">{u.email}</div>
                    </span>
                  </div>
                </td>
                <td>
                  <Form.Select size="sm" value={roleOf(u)} disabled={locked} title={locked && !self ? 'Seul un super administrateur modifie un super administrateur' : undefined} onChange={(e) => void changeRole(u, e.target.value as Role)} style={{ width: 'auto' }}>
                    <option value="user">utilisateur</option>
                    <option value="admin">administrateur</option>
                    <option value="super" disabled={!me?.isSuperAdmin}>
                      super administrateur
                    </option>
                  </Form.Select>
                </td>
                <td className="d-none d-md-table-cell" title={new Date(u.createdAt).toLocaleString()}>{timeAgo(u.createdAt)}</td>
                <td className="d-none d-md-table-cell">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : <Badge bg="secondary">en attente</Badge>}</td>
                <td className="text-end">
                  <Button
                    size="sm"
                    variant="link"
                    className="text-danger p-0 px-1"
                    disabled={self}
                    title="Supprimer"
                    onClick={async () => {
                      if (await confirm({ title: "Supprimer l'utilisateur", message: `Supprimer ${u.name} (${u.email}) ? Cette personne perdra l'accès à tous ses projets.`, confirmLabel: 'Supprimer', danger: true })) deleteUser({ variables: { userId: u.id } });
                    }}
                  >
                    <i className="bi bi-trash" />
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </>
  );
}
