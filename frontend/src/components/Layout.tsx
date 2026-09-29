import type { ReactNode } from 'react';
import { useQuery } from '@apollo/client';
import { Badge, Container, Nav, Navbar } from 'react-bootstrap';
import { Link, NavLink } from 'react-router-dom';
import { REQUESTS, type HumanRequest } from '../graphql/operations';

export default function Layout({ children }: { children: ReactNode }) {
  // Compteur global de demandes en attente, rafraîchi régulièrement.
  const { data } = useQuery<{ requests: HumanRequest[] }>(REQUESTS, { variables: { status: 'PENDING' }, pollInterval: 3000 });
  const pending = data?.requests.length ?? 0;

  return (
    <>
      <Navbar expand="sm" className="mb-4 app-navbar">
        <Container>
          <Navbar.Brand as={Link} to="/projects">
            ✻ Agents
          </Navbar.Brand>
          <Nav className="me-auto">
            <Nav.Link as={NavLink} to="/projects">
              Projets
            </Nav.Link>
            <Nav.Link as={NavLink} to="/sessions" end>
              Sessions
            </Nav.Link>
            <Nav.Link as={NavLink} to="/requests">
              Demandes{' '}
              {pending > 0 && (
                <Badge bg="warning" text="dark" pill>
                  {pending}
                </Badge>
              )}
            </Nav.Link>
          </Nav>
        </Container>
      </Navbar>
      <Container className="pb-5">{children}</Container>
    </>
  );
}
