import { render, screen } from '@testing-library/react'
import { SetupRequired } from './SetupRequired'

it('tells the user exactly which variables are missing instead of failing silently', () => {
  render(<SetupRequired missing={['VITE_SUPABASE_URL']} />)
  expect(screen.getByText('VITE_SUPABASE_URL')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent(/configuration required/i)
})
